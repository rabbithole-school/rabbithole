import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("scholarSafeTextDrops", () => {
  test("empty table summarizes to zero without oldest/newest", async () => {
    const t = convexTest(schema, modules);
    const result = await t.run(async (ctx) =>
      ctx.runQuery(internal.scholarSafeTextDrops.summary, {}),
    );
    expect(result).toEqual({
      total: 0,
      truncated: false,
      bySource: {},
      byPattern: {},
    });
  });

  test("records and summarizes text-free drop counts", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.scholarSafeTextDrops.record, {
        source: "tutor",
        pattern: "internal_marker",
        segmentLength: 31,
      });
      await ctx.runMutation(internal.scholarSafeTextDrops.record, {
        source: "story-open",
        pattern: "protocol_fragment",
        segmentLength: 42,
      });
    });

    const result = await t.run(async (ctx) =>
      ctx.runQuery(internal.scholarSafeTextDrops.summary, {}),
    );

    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.bySource).toEqual({
      tutor: 1,
      "story-open": 1,
    });
    expect(result.byPattern).toEqual({
      internal_marker: 1,
      protocol_fragment: 1,
    });
    expect(result.oldest).toBeDefined();
    expect(result.newest).toBeDefined();
    expect(result.newest!).toBeGreaterThanOrEqual(result.oldest!);
  });

  test("sinceMs excludes drops older than the window", async () => {
    const t = convexTest(schema, modules);

    // Backdate one row directly; `record` always stamps Date.now().
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarSafeTextDrops", {
        source: "tutor",
        pattern: "raw_error",
        segmentLength: 10,
        createdAt: 1_000,
      });
      await ctx.runMutation(internal.scholarSafeTextDrops.record, {
        source: "tutor",
        pattern: "stack_trace",
        segmentLength: 20,
      });
    });

    const recent = await t.run(async (ctx) =>
      ctx.runQuery(internal.scholarSafeTextDrops.summary, { sinceMs: 2_000 }),
    );
    expect(recent.total).toBe(1);
    expect(recent.byPattern).toEqual({ stack_trace: 1 });

    const all = await t.run(async (ctx) =>
      ctx.runQuery(internal.scholarSafeTextDrops.summary, { sinceMs: 0 }),
    );
    expect(all.total).toBe(2);
    expect(all.oldest).toBe(1_000);
  });
});

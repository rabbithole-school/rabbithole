import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (import.meta as ImportMeta & {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("../**/*.ts");

async function setup(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Avery Stone", username: "avery", role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId, title: "Test session", isArchived: false,
    });
    return { scholarId, sessionId };
  });
}

const signal = (ids: Awaited<ReturnType<typeof setup>>, signalType: string, description: string) => ({
  ...ids, signalType, description, intensity: "high",
});

describe("sessionSignals", () => {
  test("reruns update one row and preserve distinct types", async () => {
    const t = convexTest(schema, modules);
    const ids = await setup(t);
    const [firstId, secondId, otherId] = await t.run(async (ctx) => {
      const first = await ctx.runMutation(internal.sessionSignals.record, signal(ids, "metacognition", "first"));
      const second = await ctx.runMutation(internal.sessionSignals.record, signal(ids, "metacognition", "latest"));
      const other = await ctx.runMutation(internal.sessionSignals.record, signal(ids, "productive_struggle", "other"));
      return [first, second, other];
    });
    expect(secondId).toBe(firstId);
    expect(otherId).not.toBe(firstId);
    const rows = await t.run((ctx) => ctx.db.query("sessionSignals").collect());
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.signalType === "metacognition")?.description).toBe("latest");
  });

  test("repairs duplicates in dry-run and actual modes", async () => {
    const t = convexTest(schema, modules);
    const ids = await setup(t);
    const [oldId, newestId] = await t.run(async (ctx) => {
      const old = await ctx.db.insert("sessionSignals", signal(ids, "task_commitment", "old"));
      const newest = await ctx.db.insert("sessionSignals", signal(ids, "task_commitment", "new"));
      return [old, newest];
    });
    const dry = await t.run((ctx) => ctx.runMutation(internal.sessionSignals.repairDuplicates, { dryRun: true }));
    expect(dry.dryRun).toBe(true);
    expect(dry.candidates).toHaveLength(1);
    expect(dry.candidates[0].keepId).toBe(newestId);
    expect(dry.candidates[0].duplicateIds).toEqual([oldId]);
    expect((await t.run((ctx) => ctx.db.query("sessionSignals").collect()))).toHaveLength(2);
    await t.run((ctx) => ctx.runMutation(internal.sessionSignals.repairDuplicates, { dryRun: false }));
    const remaining = await t.run((ctx) => ctx.db.query("sessionSignals").collect());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]._id).toBe(newestId);
    expect(remaining[0].description).toBe("new");
  });
});

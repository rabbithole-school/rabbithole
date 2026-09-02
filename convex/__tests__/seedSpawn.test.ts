import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { handleSeedSpawn } from "../lib/practice/seedSpawn";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return (await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Scholar", username, role: "scholar" }),
  )) as Id<"users">;
}

describe("handleSeedSpawn (roadmap §7②)", () => {
  test("teacherNotification spawn raises a teacher alert", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "spawn_a");
    await t.run(async (ctx) =>
      handleSeedSpawn(ctx, scholarId, "remainders → clock math", {
        kind: "teacherNotification",
        note: "Reached a cross-domain gate — consider a modular-arithmetic thread.",
      }),
    );
    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("seed_spawn");
    expect(alerts[0].scholarId).toBe(scholarId);
    expect(alerts[0].body).toContain("modular-arithmetic");
  });

  test("activity spawn is a safe no-op (deferred) — raises nothing", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "spawn_b");
    await t.run(async (ctx) =>
      handleSeedSpawn(ctx, scholarId, "the area of everything", {
        kind: "activity",
        activityKind: "problem_set",
      }),
    );
    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(0);
  });

  test("dedup: the same (scholar, topic) notification fires once", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "spawn_c");
    const spawn = { kind: "teacherNotification" as const, note: "n" };
    await t.run(async (ctx) => handleSeedSpawn(ctx, scholarId, "topic-x", spawn));
    await t.run(async (ctx) => handleSeedSpawn(ctx, scholarId, "topic-x", spawn));
    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
  });
});

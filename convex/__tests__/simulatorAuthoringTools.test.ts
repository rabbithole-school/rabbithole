import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { assembleSimulatorSpec } from "../lib/simulatorTemplatesCatalog";
import { EXAMPLE_ECOSYSTEM_AUTHOR_INPUT } from "../lib/simulatorTemplatesCatalog";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const VALID_SPEC = assembleSimulatorSpec(EXAMPLE_ECOSYSTEM_AUTHOR_INPUT);
// An out-of-range width — validateEcosystemConfig rejects width > 100.
const INVALID_SPEC = assembleSimulatorSpec({
  ...EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
  config: { ...EXAMPLE_ECOSYSTEM_AUTHOR_INPUT.config, width: 9999 },
});

async function seedLesson(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      username: "world-author",
      name: "World Author",
      role: "teacher",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Bot Worlds",
      slug: "bot-worlds",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Terrariums",
      order: 0,
    });
    return { teacherId, unitId, lessonId };
  });
}

describe("Curriculum Bot world-authoring mutations", () => {
  test("createSimulatorActivityInternal creates a validated kind:simulator activity", async () => {
    const t = convexTest(schema, modules);
    const { lessonId } = await seedLesson(t);

    const res = await t.mutation(internal.simulator.createSimulatorActivityInternal, {
      lessonId,
      title: "Reef Terrarium",
      spec: VALID_SPEC,
    });
    expect(res.existed).toBe(false);

    const activity = await t.run((ctx) => ctx.db.get(res.activityId));
    expect(activity?.kind).toBe("simulator");
    expect(activity?.simulatorSpec?.templateId).toBe("ecosystemGrid");
    expect(activity?.title).toBe("Reef Terrarium");
  });

  test("createSimulatorActivityInternal is idempotent by title (reconfigures in place)", async () => {
    const t = convexTest(schema, modules);
    const { lessonId } = await seedLesson(t);

    const first = await t.mutation(internal.simulator.createSimulatorActivityInternal, {
      lessonId,
      title: "Reef Terrarium",
      spec: VALID_SPEC,
    });
    const second = await t.mutation(internal.simulator.createSimulatorActivityInternal, {
      lessonId,
      title: "reef terrarium", // case-insensitive match
      spec: VALID_SPEC,
    });
    expect(second.existed).toBe(true);
    expect(second.activityId).toBe(first.activityId);

    const count = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
          .collect()
      ).length,
    );
    expect(count).toBe(1);
  });

  test("createSimulatorActivityInternal rejects an invalid spec and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { lessonId } = await seedLesson(t);

    await expect(
      t.mutation(internal.simulator.createSimulatorActivityInternal, {
        lessonId,
        title: "Bad World",
        spec: INVALID_SPEC,
      }),
    ).rejects.toThrow(/dimensions must be integers/i);

    const count = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
          .collect()
      ).length,
    );
    expect(count).toBe(0);
  });

  test("setSimulatorSpecInternal converts an existing activity into a validated world", async () => {
    const t = convexTest(schema, modules);
    const { lessonId } = await seedLesson(t);

    const activityId: Id<"activities"> = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Was Offline",
        order: 0,
        kind: "offline",
      }),
    );

    const res = await t.mutation(internal.simulator.setSimulatorSpecInternal, {
      activityId,
      spec: VALID_SPEC,
    });
    expect(res.ok).toBe(true);

    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.kind).toBe("simulator");
    expect(activity?.simulatorSpec?.templateId).toBe("ecosystemGrid");
  });

  test("setSimulatorSpecInternal rejects an invalid spec", async () => {
    const t = convexTest(schema, modules);
    const { lessonId } = await seedLesson(t);
    const activityId: Id<"activities"> = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Keep Offline",
        order: 0,
        kind: "offline",
      }),
    );

    await expect(
      t.mutation(internal.simulator.setSimulatorSpecInternal, {
        activityId,
        spec: INVALID_SPEC,
      }),
    ).rejects.toThrow(/dimensions must be integers/i);

    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.kind).toBe("offline");
    expect(activity?.simulatorSpec).toBeUndefined();
  });

  test("converting an activity to a world clears its recipe (no longer an EQ/EU assessment)", async () => {
    const t = convexTest(schema, modules);
    const { lessonId } = await seedLesson(t);
    const activityId: Id<"activities"> = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Baseline Check",
        order: 0,
        kind: "offline",
        recipe: "baseline",
      }),
    );

    await t.mutation(internal.simulator.setSimulatorSpecInternal, {
      activityId,
      spec: VALID_SPEC,
    });

    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.kind).toBe("simulator");
    // The recipe must be gone — granule assessment gates purely on `recipe`.
    expect(activity?.recipe).toBeUndefined();
  });

  test("createSimulatorActivityInternal will NOT convert a non-world activity that shares a title", async () => {
    const t = convexTest(schema, modules);
    const { lessonId } = await seedLesson(t);
    const offlineId: Id<"activities"> = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Reef Terrarium",
        order: 0,
        kind: "offline",
        recipe: "baseline",
      }),
    );

    const res = await t.mutation(internal.simulator.createSimulatorActivityInternal, {
      lessonId,
      title: "Reef Terrarium", // same title as the offline activity
      spec: VALID_SPEC,
    });
    // A new world is inserted; the offline activity is left untouched.
    expect(res.existed).toBe(false);
    expect(res.activityId).not.toBe(offlineId);

    const offline = await t.run((ctx) => ctx.db.get(offlineId));
    expect(offline?.kind).toBe("offline");
    expect(offline?.recipe).toBe("baseline");
    expect(offline?.simulatorSpec).toBeUndefined();

    const worlds = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
          .collect()
      ).filter((a) => a.kind === "simulator"),
    );
    expect(worlds).toHaveLength(1);
    expect(worlds[0]._id).toBe(res.activityId);
  });
});

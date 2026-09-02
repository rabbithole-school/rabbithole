import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: string,
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `T ${role}`, username, role } as Doc<"users">),
  );
}

/** Unit → lesson → offline activity. */
async function seedActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "U",
      isActive: true,
    } as Doc<"units">);
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Worksheet",
      kind: "offline",
      order: 0,
    } as Doc<"activities">);
    return { unitId, activityId };
  });
}

/** Assignment with an optional live schedule entry for `activityId`. */
async function seedAssignment(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  unitId: Id<"units">,
  scholarId: Id<"users">,
  liveActivityId: Id<"activities"> | null,
  entryScholarIds?: Id<"users">[],
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now(),
      activitySchedule: liveActivityId
        ? [
            {
              activityId: liveActivityId,
              mode: "classFocus" as const,
              // Live: went live a minute ago, no end → window is [setAt, ∞).
              setAt: Date.now() - 60_000,
              ...(entryScholarIds !== undefined
                ? { scholarIds: entryScholarIds }
                : {}),
            },
          ]
        : [],
    }),
  );
}

async function storageId(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.storage.store(new Blob(["x"], { type: "application/pdf" })),
  );
}

async function insertSegment(
  t: ReturnType<typeof convexTest>,
  args: {
    scholarId: Id<"users">;
    assignmentId: Id<"assignments">;
    fileStorageId: Id<"_storage">;
  },
) {
  return await t.run(async (ctx) =>
    ctx.runMutation(internal.portfolio.insertSegment, {
      source: "google_drive",
      title: "scan.pdf",
      fileStorageId: args.fileStorageId,
      scholarId: args.scholarId,
      matchStatus: "matched",
      matchConfidence: 0.9,
      assignmentId: args.assignmentId,
      assignmentStatus: "matched",
    }),
  );
}

describe("scan auto-file via the live activity window (capstone)", () => {
  test("a matched scan auto-tags the live activity and materializes", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { unitId, activityId } = await seedActivity(t, teacherId);
    const assignmentId = await seedAssignment(
      t,
      teacherId,
      unitId,
      scholarId,
      activityId, // this activity is LIVE right now
    );
    const fileStorageId = await storageId(t);

    const itemId = await insertSegment(t, {
      scholarId,
      assignmentId,
      fileStorageId,
    });

    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.activityId).toBe(activityId);

    const deliverables = await t.run((ctx) =>
      ctx.db.query("deliverables").collect(),
    );
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0].portfolioItemId).toBe(itemId);
    expect(deliverables[0].activityId).toBe(activityId);
  });

  test("no live window → activity stays open, nothing materializes", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { unitId } = await seedActivity(t, teacherId);
    // Assignment with NO live schedule entry.
    const assignmentId = await seedAssignment(
      t,
      teacherId,
      unitId,
      scholarId,
      null,
    );
    const fileStorageId = await storageId(t);

    const itemId = await insertSegment(t, {
      scholarId,
      assignmentId,
      fileStorageId,
    });

    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.activityId).toBeUndefined();
    expect(
      await t.run((ctx) => ctx.db.query("deliverables").collect()),
    ).toHaveLength(0);
  });

  test("a live entry targeted to another rostered scholar does not auto-file", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const targetedScholarId = await seedUser(t, "scholar", "s2");
    const { unitId, activityId } = await seedActivity(t, teacherId);
    const assignmentId = await seedAssignment(
      t,
      teacherId,
      unitId,
      scholarId,
      activityId,
      [targetedScholarId],
    );
    await t.run(async (ctx) => {
      const assignment = await ctx.db.get(assignmentId);
      await ctx.db.patch(assignmentId, {
        scholarIds: [...assignment!.scholarIds, targetedScholarId],
      });
    });

    const itemId = await insertSegment(t, {
      scholarId,
      assignmentId,
      fileStorageId: await storageId(t),
    });

    const item = await t.run((ctx) => ctx.db.get(itemId));
    expect(item?.activityId).toBeUndefined();
    expect(
      await t.run((ctx) => ctx.db.query("deliverables").collect()),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("activityCompletions").collect()),
    ).toHaveLength(0);
  });
});

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { makeAssignmentTools } from "../lib/assignmentTools";

/**
 * The `add_activity_resource` aide tool (TRA-280) — a video's canonical home is
 * an activity resource, not a per-scholar web assignment. Build the real tool
 * closure against a convex-test backend (routing the ActionCtx runQuery/
 * runMutation to the harness) and drive it the way the bot would, proving the
 * tool → internal.activityResources.aideAddUrlResource → insert wiring, the
 * default-kind logic, and the strict activity-name discipline.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

function actionCtxFor(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

async function addResourceTool(
  t: ReturnType<typeof convexTest>,
  callerUserId: Id<"users">,
) {
  const tools = await makeAssignmentTools(actionCtxFor(t), () => {}, {
    role: "teacher",
    callerUserId,
  });
  const tool = tools.find((tl) => tl.name === "add_activity_resource")! as unknown as {
    run: (input: Record<string, unknown>) => Promise<string>;
  };
  return tool;
}

async function seedWorld(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Test School",
      slug: "test-school",
      kind: "school",
      isPrimary: true,
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Test Teacher",
      username: "testteacher",
      role: "teacher",
      institutionId,
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Test Scholar",
      username: "testscholar",
      role: "scholar",
      institutionId,
    });
    await ctx.db.insert("memberships", {
      userId: teacherId,
      role: "teacher",
      institutionId,
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Marine Life",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Tide Pools",
      order: 0,
    });
    const watchActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Watch and Wonder",
      kind: "online",
      order: 0,
    });
    // Two activities that share a substring — a partial "tide pool" query is
    // ambiguous and must be refused (strict-name discipline).
    await ctx.db.insert("activities", {
      lessonId,
      title: "Tide Pool Morning",
      kind: "online",
      order: 1,
    });
    await ctx.db.insert("activities", {
      lessonId,
      title: "Tide Pool Afternoon",
      kind: "online",
      order: 2,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now(),
      activitySchedule: [],
      kind: "unit",
    });
    return { institutionId, teacherId, scholarId, unitId, watchActivityId, assignmentId };
  });
}

const resourcesFor = (
  t: ReturnType<typeof convexTest>,
  activityId: Id<"activities">,
) =>
  t.run(async (ctx) =>
    ctx.db
      .query("activityResources")
      .filter((q) => q.eq(q.field("activityId"), activityId))
      .collect(),
  );

describe("add_activity_resource tool", () => {
  test("happy path: attaches a YouTube URL as a sandboxed video (default kind)", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, watchActivityId, assignmentId } = await seedWorld(t);
    const tool = await addResourceTool(t, teacherId);

    const out = await tool.run({
      assignmentId,
      activityTitle: "Watch and Wonder",
      url: "https://www.youtube.com/watch?v=lZUyUkJMc3U",
    });

    const parsed = JSON.parse(out) as {
      ok: boolean;
      kind: string;
      message: string;
      activityTitle: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe("video");
    expect(parsed.message).toBe(
      'Added video "Video" to Watch and Wonder (Marine Life)',
    );

    const resources = (await resourcesFor(t, watchActivityId)) as Doc<"activityResources">[];
    expect(resources).toHaveLength(1);
    expect(resources[0].source).toEqual({
      kind: "video",
      url: "https://www.youtube.com/watch?v=lZUyUkJMc3U",
    });
    expect(resources[0].uploadedBy).toBe(teacherId);
    expect(resources[0].title).toBe("Video");
  });

  test("a non-YouTube URL defaults to a link, and an explicit title is kept", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, watchActivityId, assignmentId } = await seedWorld(t);
    const tool = await addResourceTool(t, teacherId);

    const out = await tool.run({
      assignmentId,
      activityTitle: "watch and wonder",
      url: "https://example.com/reef-guide",
      title: "Reef field guide",
    });
    const parsed = JSON.parse(out) as { kind: string; message: string };
    expect(parsed.kind).toBe("link");
    expect(parsed.message).toBe(
      'Added link "Reef field guide" to Watch and Wonder (Marine Life)',
    );

    const resources = (await resourcesFor(t, watchActivityId)) as Doc<"activityResources">[];
    expect(resources).toHaveLength(1);
    expect(resources[0].source).toEqual({
      kind: "link",
      url: "https://example.com/reef-guide",
    });
    expect(resources[0].title).toBe("Reef field guide");
  });

  test("refuses an ambiguous activity name and attaches nothing", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, assignmentId, unitId } = await seedWorld(t);
    const tool = await addResourceTool(t, teacherId);

    const out = await tool.run({
      assignmentId,
      activityTitle: "Tide Pool",
      url: "https://www.youtube.com/watch?v=lZUyUkJMc3U",
    });
    expect(out).toMatch(/Ambiguous activity "Tide Pool"/);
    expect(out).toContain("Tide Pool Morning");
    expect(out).toContain("Tide Pool Afternoon");

    // Nothing was written to any activity in the unit.
    const total = await t.run(async (ctx) => {
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect();
      let count = 0;
      for (const l of lessons) {
        const acts = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect();
        for (const a of acts) {
          count += (
            await ctx.db
              .query("activityResources")
              .withIndex("by_activity", (q) => q.eq("activityId", a._id))
              .collect()
          ).length;
        }
      }
      return count;
    });
    expect(total).toBe(0);
  });

  test("resolves the assignment by title too", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, watchActivityId } = await seedWorld(t);
    const tool = await addResourceTool(t, teacherId);

    const out = await tool.run({
      assignmentTitle: "Marine Life",
      activityTitle: "Watch and Wonder",
      url: "https://youtu.be/lZUyUkJMc3U",
    });
    const parsed = JSON.parse(out) as { ok: boolean; kind: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe("video");
    const resources = (await resourcesFor(t, watchActivityId)) as Doc<"activityResources">[];
    expect(resources).toHaveLength(1);
  });

  test("a non-teacher caller is refused by the internal mutation", async () => {
    const t = convexTest(schema, modules);
    const { assignmentId } = await seedWorld(t);
    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Sneaky", username: "sneaky", role: "scholar" }),
    );
    const tool = await addResourceTool(t, scholarId);
    const out = await tool.run({
      assignmentId,
      activityTitle: "Watch and Wonder",
      url: "https://www.youtube.com/watch?v=lZUyUkJMc3U",
    });
    // The tool resolves against the caller's own assignments; a scholar owns
    // none, so it never reaches the write — either way, nothing is added.
    expect(out).toMatch(/no resource was added|Could not add the resource/i);
  });
});

/**
 * Direct regression for the internal mutation the tool writes through — the
 * TRA-245 point of the whole refactor: because it goes through the same
 * requireResourceEditAccessForUser gate the UI uses, it enforces the role gate
 * AND the institution boundary even though the aide has no `ctx.user`. The
 * tool-level test above never reaches the mutation (assignment resolution
 * rejects a foreign caller first), so exercise the mutation directly here.
 */
describe("aideAddUrlResource access gate (direct)", () => {
  const seedActivityInInstitution = async (
    t: ReturnType<typeof convexTest>,
    opts: { slug: string; teacherName: string; teacherUser: string },
  ) =>
    t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: opts.slug,
        slug: opts.slug,
        kind: "school",
        isPrimary: opts.slug === "inst-a",
      });
      const teacherId = await ctx.db.insert("users", {
        name: opts.teacherName,
        username: opts.teacherUser,
        role: "teacher",
        institutionId,
      });
      await ctx.db.insert("memberships", {
        userId: teacherId,
        role: "teacher",
        institutionId,
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        institutionId,
        title: `${opts.slug} Unit`,
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Activity",
        kind: "online",
        order: 0,
      });
      return { institutionId, teacherId, activityId };
    });

  const resourceCount = (
    t: ReturnType<typeof convexTest>,
    activityId: Id<"activities">,
  ) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("activityResources")
          .filter((q) => q.eq(q.field("activityId"), activityId))
          .collect()
      ).length,
    );

  test("a teacher from another institution is rejected with no write", async () => {
    const t = convexTest(schema, modules);
    const { activityId } = await seedActivityInInstitution(t, {
      slug: "inst-a",
      teacherName: "Teacher A",
      teacherUser: "teachera",
    });
    const { teacherId: teacherB } = await seedActivityInInstitution(t, {
      slug: "inst-b",
      teacherName: "Teacher B",
      teacherUser: "teacherb",
    });

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.activityResources.aideAddUrlResource, {
          callerUserId: teacherB,
          activityId,
          title: "Sneaky",
          url: "https://www.youtube.com/watch?v=lZUyUkJMc3U",
          kind: "video",
        }),
      ),
    ).rejects.toThrow(/Forbidden|not in your institution|not allowed/i);

    expect(await resourceCount(t, activityId)).toBe(0);
  });

  test("a non-teacher caller is rejected by the role gate with no write", async () => {
    const t = convexTest(schema, modules);
    const { activityId, institutionId } = await seedActivityInInstitution(t, {
      slug: "inst-a",
      teacherName: "Teacher A",
      teacherUser: "teachera",
    });
    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Scholar",
        username: "scholar-direct",
        role: "scholar",
        institutionId,
      }),
    );

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.activityResources.aideAddUrlResource, {
          callerUserId: scholarId,
          activityId,
          title: "Nope",
          url: "https://www.youtube.com/watch?v=lZUyUkJMc3U",
          kind: "video",
        }),
      ),
    ).rejects.toThrow(/teacher\/admin only/i);

    expect(await resourceCount(t, activityId)).toBe(0);
  });
});


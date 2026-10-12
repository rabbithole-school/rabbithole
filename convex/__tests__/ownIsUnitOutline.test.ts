/**
 * The unit-level planning chat in a scholar's own Independent Study unit must
 * see what the unit already holds (TRA-464): an "Endless chat" quest gets its
 * lessons + activities from a background bake that never touches the chat, so
 * without this the planning tutor re-plans a unit that is already built.
 * Pins the context data, not prompt wording.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { resolveActivityScopedContext } from "../sessionHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function setup(opts: { ownedByScholar: boolean }) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Scholar",
      username: "scholar-outline",
      role: "scholar",
    });
    const otherId = await ctx.db.insert("users", {
      name: "Other",
      username: "other-outline",
      role: "scholar",
    });
    const owner = opts.ownedByScholar ? scholarId : otherId;
    const unitId = await ctx.db.insert("units", {
      teacherId: owner,
      title: "Volcanoes",
      isActive: true,
      authorScholarId: owner,
    });
    // Inserted out of order to prove the outline sorts by `order`.
    const lesson2 = await ctx.db.insert("lessons", {
      unitId,
      title: "Second lesson",
      order: 1,
    });
    const lesson1 = await ctx.db.insert("lessons", {
      unitId,
      title: "First lesson",
      order: 0,
    });
    const b = await ctx.db.insert("activities", {
      lessonId: lesson1,
      title: "B",
      kind: "online",
      order: 1,
    });
    const a = await ctx.db.insert("activities", {
      lessonId: lesson1,
      title: "A",
      kind: "online",
      order: 0,
    });
    await ctx.db.insert("activities", {
      lessonId: lesson1,
      title: "Archived",
      kind: "online",
      order: 2,
      archivedAt: Date.now(),
    });
    await ctx.db.insert("activityCompletions", {
      scholarId,
      activityId: a,
      lessonId: lesson1,
      unitId,
      completedAt: Date.now(),
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Planning",
      isArchived: false,
      unitId,
    });
    return { unitId, sessionId, scholarId, activityB: b, lesson2 };
  });
  return { t, ...ids };
}

function resolve(
  t: ReturnType<typeof convexTest>,
  args: {
    sessionId: Id<"sessions">;
    unitId: Id<"units">;
    activityId: Id<"activities"> | null;
  },
) {
  return t.run(async (ctx) => {
    const session = await ctx.db.get(args.sessionId);
    const scoped = await resolveActivityScopedContext(ctx, {
      activityId: args.activityId,
      unitId: args.activityId ? undefined : args.unitId,
      session,
    });
    return scoped.unitContext;
  });
}

describe("own IS unit outline in the planning-chat context", () => {
  test("lists lessons and non-archived activities in order, with completion", async () => {
    const { t, sessionId, unitId } = await setup({ ownedByScholar: true });
    const unitContext = await resolve(t, { sessionId, unitId, activityId: null });
    expect(unitContext?.isOwnIsUnit).toBe(true);
    expect(unitContext?.ownIsUnitOutline).toEqual([
      {
        title: "First lesson",
        activities: [
          { title: "A", done: true },
          { title: "B", done: false },
        ],
      },
      { title: "Second lesson", activities: [] },
    ]);
  });

  test("next activity is the first unfinished launchable one (offline skipped)", async () => {
    const { t, sessionId, unitId, activityB } = await setup({
      ownedByScholar: true,
    });
    const before = await resolve(t, { sessionId, unitId, activityId: null });
    expect(before?.ownIsUnitNextActivityTitle).toBe("B");

    // An offline activity can't be launched from "where you are", so it is
    // never named as next — same pick as native's Up next.
    await t.run((ctx) => ctx.db.patch(activityB, { kind: "offline" }));
    const after = await resolve(t, { sessionId, unitId, activityId: null });
    expect(after?.ownIsUnitNextActivityTitle).toBeNull();
  });

  test("not loaded inside an activity session", async () => {
    const { t, sessionId, unitId, activityB } = await setup({
      ownedByScholar: true,
    });
    const unitContext = await resolve(t, {
      sessionId,
      unitId,
      activityId: activityB,
    });
    expect(unitContext?.isOwnIsUnit).toBe(true);
    expect(unitContext?.ownIsUnitOutline).toBeUndefined();
  });

  test("structure from elsewhere (a bake) is not marked as built in this chat", async () => {
    const { t, sessionId, unitId } = await setup({ ownedByScholar: true });
    const unitContext = await resolve(t, { sessionId, unitId, activityId: null });
    expect(unitContext?.ownIsUnitBuiltInChat).toBe(false);
  });

  test("the planning tutor's own create_activity marks the chat as the builder", async () => {
    const { t, sessionId, unitId, scholarId, lesson2 } = await setup({
      ownedByScholar: true,
    });
    await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId: lesson2,
      scholarId,
      unitId,
      title: "C",
      kind: "online",
      systemPrompt: "Help the scholar explore C.",
      sessionId,
    });
    const unitContext = await resolve(t, { sessionId, unitId, activityId: null });
    expect(unitContext?.ownIsUnitBuiltInChat).toBe(true);
    expect(unitContext?.ownIsUnitOutline?.[1]?.activities).toEqual([
      { title: "C", done: false },
    ]);
  });

  test("a create in another scholar's session does not stamp it", async () => {
    const { t, sessionId, unitId } = await setup({
      ownedByScholar: true,
    });
    const otherScholarSession = await t.run(async (ctx) => {
      const other = await ctx.db.insert("users", {
        name: "Third",
        username: "third-outline",
        role: "scholar",
      });
      return ctx.db.insert("sessions", {
        userId: other,
        title: "Elsewhere",
        isArchived: false,
        unitId,
      });
    });
    const scholarId = await t.run(
      async (ctx) => (await ctx.db.get(sessionId))!.userId,
    );
    await t.mutation(internal.lessons.aiCreateForIsUnit, {
      unitId,
      scholarId,
      title: "Another lesson",
      sessionId: otherScholarSession,
    });
    const stamped = await t.run(
      async (ctx) => !!(await ctx.db.get(otherScholarSession))?.unitBuiltInChatAt,
    );
    expect(stamped).toBe(false);
  });

  test("not loaded for a unit the scholar does not own", async () => {
    const { t, sessionId, unitId } = await setup({ ownedByScholar: false });
    const unitContext = await resolve(t, { sessionId, unitId, activityId: null });
    expect(unitContext?.isOwnIsUnit).toBe(false);
    expect(unitContext?.ownIsUnitOutline).toBeUndefined();
  });
});

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
import { api, internal } from "../_generated/api";
import {
  buildSystemPromptParts,
  resolveActivityScopedContext,
} from "../sessionHelpers";

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

  // An activity session of the scholar's own Quest is offered create_lesson /
  // create_activity too, so it must see what the unit holds: the tutor never
  // sees its earlier tool calls, and without this list it confessed to "not
  // running the tools" and rebuilt the same lessons seven times in prod.
  test("loaded inside an activity session, which is not the planning chat", async () => {
    const { t, sessionId, unitId, activityB, scholarId } = await setup({
      ownedByScholar: true,
    });
    await t.mutation(internal.lessons.aiCreateForIsUnit, {
      unitId,
      scholarId,
      title: "Built mid-activity",
    });
    const unitContext = await resolve(t, {
      sessionId,
      unitId,
      activityId: activityB,
    });
    expect(unitContext?.isOwnIsUnit).toBe(true);
    expect(unitContext?.isPlanningChat).toBeUndefined();
    expect(unitContext?.ownIsUnitOutline?.map((l) => l.title)).toEqual([
      "First lesson",
      "Second lesson",
      "Built mid-activity",
    ]);
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

describe("Quest create tools are idempotent on title", () => {
  test("re-creating a lesson with the same title returns the existing one", async () => {
    const { t, unitId, scholarId } = await setup({ ownedByScholar: true });
    const plan = ["Building the yardstick", "When tiny odds pile up"];
    const first = [];
    for (const title of plan) {
      first.push(
        await t.mutation(internal.lessons.aiCreateForIsUnit, {
          unitId,
          scholarId,
          title,
        }),
      );
    }
    // The tutor re-issues the same plan, with incidental case/space drift.
    const again = [];
    for (const title of ["  building the  YARDSTICK ", "When tiny odds pile up"]) {
      again.push(
        await t.mutation(internal.lessons.aiCreateForIsUnit, {
          unitId,
          scholarId,
          title,
        }),
      );
    }
    expect(again).toEqual(first);
    const titles = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", unitId))
          .collect()
      ).map((l) => l.title),
    );
    expect(titles).toHaveLength(4); // 2 seeded + 2 created once
  });

  test("re-creating an activity in the same lesson returns the existing one", async () => {
    const { t, unitId, scholarId, lesson2 } = await setup({
      ownedByScholar: true,
    });
    const args = {
      lessonId: lesson2,
      scholarId,
      unitId,
      title: "The showdown",
      kind: "online" as const,
      systemPrompt: "Compare the two odds.",
    };
    const a = await t.mutation(internal.activities.aiCreateForIsUnit, args);
    const b = await t.mutation(internal.activities.aiCreateForIsUnit, args);
    expect(b).toBe(a);
    const count = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson2))
          .collect()
      ).length,
    );
    expect(count).toBe(1);
  });

  test("an archived activity with the same title does not block a new one", async () => {
    const { t, unitId, scholarId } = await setup({ ownedByScholar: true });
    const lessonId = await t.run(async (ctx) =>
      (await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect()).find((l) => l.title === "First lesson")!._id,
    );
    const id = await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId,
      scholarId,
      unitId,
      title: "Archived",
      kind: "online",
      systemPrompt: "Try again.",
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.archivedAt).toBeUndefined();
  });
});

// The co-design block the tutor reads (buildSystemPromptParts' unit slot is
// the 3rd positional arg; see beginnerReaderSection.test.ts for the shape).
function unitPrompt(unit: Record<string, unknown>): string {
  const args: unknown[] = new Array(60).fill(undefined);
  args.splice(0, 5, null, "Kai", unit, null, null);
  return (
    buildSystemPromptParts as unknown as (
      ...a: unknown[]
    ) => ReturnType<typeof buildSystemPromptParts>
  )(...args).stable;
}

describe("own Quest co-design prompt", () => {
  const quest = {
    title: "Odds",
    description: null,
    systemPrompt: null,
    rubric: null,
    youtubeUrl: null,
    videoTranscript: null,
    bigIdea: null,
    essentialQuestions: null,
    enduringUnderstandings: null,
    isOwnIsUnit: true,
    ownIsUnitOutline: [
      { title: "Building the yardstick", activities: [{ title: "Measure it", done: false }] },
    ],
    ownIsUnitBuiltInChat: false,
    ownIsUnitNextActivityTitle: "Measure it",
  };
  const READY = "say once that their activities are ready";

  // Since TRA-682 the tutor adds no lessons or activities to a kid's own
  // Quest, so the old "where what you build shows up" and "never say you did
  // not build it" lines are gone; the outline still shows what the Quest holds.
  test("an activity session lists the unit's parts", () => {
    const prompt = unitPrompt(quest);
    expect(prompt).toContain('Lesson: "Building the yardstick"');
    expect(prompt).not.toContain(READY);
  });

  test("the planning chat still offers the built activities once", () => {
    const prompt = unitPrompt({ ...quest, isPlanningChat: true });
    expect(prompt).toContain(READY);
    expect(prompt).toContain('Lesson: "Building the yardstick"');
  });
});

// Reproduction for the "it's not there" report: the rows the planning tutor's
// tools write are visible, live, to the scholar through the queries behind the
// Quest outline she reaches from Home → Quests (web UnitProgressDialog and
// native /unit-progress both read exactly these). The read path was never the
// bug; the tutor pointed her at the session list on the left.
describe("tool-created Quest lessons reach the scholar's Quest outline", () => {
  test("lessons and activities appear in the outline queries", async () => {
    const { t, unitId, scholarId } = await setup({ ownedByScholar: true });
    const lessonId = await t.mutation(internal.lessons.aiCreateForIsUnit, {
      unitId,
      scholarId,
      title: "Building the yardstick",
    });
    await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId,
      scholarId,
      unitId,
      title: "Measure the odds",
      kind: "online",
      systemPrompt: "Build a yardstick for chance.",
    });
    const authSession = await t.run((ctx) =>
      ctx.db.insert("authSessions", {
        userId: scholarId,
        expirationTime: Date.now() + 60 * 60 * 1000,
      }),
    );
    const asScholar = t.withIdentity({
      subject: `${scholarId}|${authSession}`,
      issuer: "https://convex.dev",
    });
    const lessons = await asScholar.query(api.lessons.listByUnitPublic, {
      unitId,
    });
    expect(lessons.map((l) => l.title)).toContain("Building the yardstick");
    const activities = await asScholar.query(api.activities.listByUnitPublic, {
      unitId,
      includeResources: true,
    });
    expect(
      activities.find((a) => a.title === "Measure the odds")?.lessonId,
    ).toBe(lessonId);
  });
});

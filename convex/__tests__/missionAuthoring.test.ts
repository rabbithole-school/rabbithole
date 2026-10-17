// TRA-519 PR3 lane B — the writers of a mission: the build-path bake
// normalizer (B4) and its learn-before-you-build reorder (B6), Quest
// co-design's create_activity (app + mission, B6 refusal), the Quest mission
// (set_quest_mission → units.aiSetIsUnitMission, B5) and the Curriculum Bot
// writing a non-app mission (B5.4). No model calls.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { getFunctionName } from "convex/server";
import { assembleUnitDesignerTools } from "../lib/unitDesignerTools";
import {
  makeTutorSessionTools,
  type TutorToolSessionState,
} from "../lib/tutorSessionTools";
import { QUEST_BUILD_NEEDS_LEARNING_STEP } from "../activities";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

async function seedQuest(t: T) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Kai Nakoa",
      username: `scholar-${crypto.randomUUID()}`,
      role: "scholar",
    });
    const otherScholarId = await ctx.db.insert("users", {
      name: "Mele Aukai",
      username: `scholar-${crypto.randomUUID()}`,
      role: "scholar",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      authorScholarId: scholarId,
      title: "Why do bridges sag?",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Loads and spans",
      order: 0,
    });
    return { scholarId, otherScholarId, unitId, lessonId };
  });
}

const activitiesIn = (t: T, lessonId: Id<"lessons">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
        .collect()
    ).sort((a, b) => a.order - b.order),
  );

describe("normalizeBakedActivityOrder", () => {
  async function seedStages(
    t: T,
    lessonId: Id<"lessons">,
    rows: Array<{
      title: string;
      stage: string;
      order: number;
      app?: boolean;
      contract?: boolean;
    }>,
  ) {
    await t.run(async (ctx) => {
      for (const row of rows) {
        await ctx.db.insert("activities", {
          lessonId,
          title: row.title,
          kind: "online",
          ...(row.app ? { appActivity: true } : {}),
          order: row.order,
          deliverable: {
            kind: row.app ? "artifact" : "text",
            prompt: `Do ${row.title}`,
            mode: "auto",
            notes: `[bake-stage:${row.stage}] Quality bar for ${row.title}.`,
            criteria: [],
          },
          ...(row.contract
            ? {
                buildContract: {
                  invariants: ["A longer span sags more under the same truck"],
                  freedoms: ["the bridge's look"],
                  gate: "The mechanism runs once with default settings.",
                },
              }
            : {}),
        });
      }
    });
  }

  test("build path: repairs an extend stage the bot left as a text activity", async () => {
    const t = convexTest(schema, modules);
    const { unitId, lessonId } = await seedQuest(t);
    await seedStages(t, lessonId, [
      { title: "Build it", stage: "extend", order: 0 },
      { title: "Bet", stage: "commit", order: 1 },
      { title: "Name the rule", stage: "reckon", order: 2 },
      { title: "Load test", stage: "capture", order: 3 },
    ]);
    const res = await t.mutation(
      internal.bakeUnitFromSeed.normalizeBakedActivityOrder,
      { unitId, build: true },
    );
    expect(res).toEqual({ normalized: true, reason: null });
    const rows = await activitiesIn(t, lessonId);
    expect(rows.map((r) => r.title)).toEqual([
      "Bet",
      "Load test",
      "Name the rule",
      "Build it",
    ]);
    const build = rows[3];
    expect(build).toMatchObject({ kind: "online", appActivity: true });
    expect(build.deliverable).toMatchObject({
      kind: "artifact",
      mode: "auto",
      notes: "Quality bar for Build it.",
    });
    // No contract: kept (the default app gate applies), not refused.
    expect(build.buildContract).toBeUndefined();
    expect(rows[0].deliverable?.notes).toBe("Quality bar for Bet.");
  });

  test("build path: a well-formed app build keeps its contract", async () => {
    const t = convexTest(schema, modules);
    const { unitId, lessonId } = await seedQuest(t);
    await seedStages(t, lessonId, [
      { title: "Bet", stage: "commit", order: 0 },
      { title: "Load test", stage: "capture", order: 1 },
      { title: "Name the rule", stage: "reckon", order: 2 },
      { title: "Build it", stage: "extend", order: 3, app: true, contract: true },
    ]);
    await t.mutation(internal.bakeUnitFromSeed.normalizeBakedActivityOrder, {
      unitId,
      build: true,
    });
    const build = (await activitiesIn(t, lessonId))[3];
    expect(build.appActivity).toBe(true);
    expect(build.buildContract?.gate).toBe(
      "The mechanism runs once with default settings.",
    );
  });

  test("build path requires exactly 4 activities", async () => {
    const t = convexTest(schema, modules);
    const { unitId, lessonId } = await seedQuest(t);
    await seedStages(t, lessonId, [
      { title: "Bet", stage: "commit", order: 0 },
      { title: "Load test", stage: "capture", order: 1 },
      { title: "Name the rule", stage: "reckon", order: 2 },
    ]);
    const res = await t.mutation(
      internal.bakeUnitFromSeed.normalizeBakedActivityOrder,
      { unitId, build: true },
    );
    expect(res.normalized).toBe(false);
  });

  test("B6, any Quest bake: an app activity never precedes the first learning step", async () => {
    const t = convexTest(schema, modules);
    const { unitId, lessonId } = await seedQuest(t);
    await seedStages(t, lessonId, [
      { title: "Make a bridge app", stage: "commit", order: 0, app: true },
      { title: "Load test", stage: "capture", order: 1 },
      { title: "Name the rule", stage: "reckon", order: 2 },
    ]);
    const res = await t.mutation(
      internal.bakeUnitFromSeed.normalizeBakedActivityOrder,
      { unitId },
    );
    expect(res.normalized).toBe(true);
    expect((await activitiesIn(t, lessonId)).map((r) => r.title)).toEqual([
      "Load test",
      "Make a bridge app",
      "Name the rule",
    ]);
  });
});

describe("activities.aiCreateForIsUnit (Quest co-design)", () => {
  test("an app as the Quest's first step is refused legibly", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, lessonId } = await seedQuest(t);
    await expect(
      t.mutation(internal.activities.aiCreateForIsUnit, {
        lessonId,
        scholarId,
        unitId,
        title: "Bridge simulator",
        kind: "online",
        appActivity: true,
        systemPrompt: "Build a bridge that sags under trucks.",
      }),
    ).rejects.toThrow(QUEST_BUILD_NEEDS_LEARNING_STEP);
    // An away-from-screen step does not count as learning first.
    await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId,
      scholarId,
      unitId,
      title: "Build a paper bridge",
      kind: "offline",
      systemPrompt: "Fold paper into a bridge.",
    });
    await expect(
      t.mutation(internal.activities.aiCreateForIsUnit, {
        lessonId,
        scholarId,
        unitId,
        title: "Bridge simulator",
        kind: "online",
        appActivity: true,
        systemPrompt: "Build a bridge that sags under trucks.",
      }),
    ).rejects.toThrow(/Add a learning step first/);
  });

  test("after a learning step, an app activity is created with its mission", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, lessonId } = await seedQuest(t);
    await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId,
      scholarId,
      unitId,
      title: "Find the rule",
      kind: "online",
      systemPrompt: "Work out how span length changes sag.",
      mission: { gate: "A first table of loads and sags exists.", freedoms: ["which trucks"] },
    });
    // A later lesson: the learning step in the earlier lesson precedes it.
    const laterLessonId = await t.run((ctx) =>
      ctx.db.insert("lessons", { unitId, title: "Build", order: 1 }),
    );
    const appId = await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId: laterLessonId,
      scholarId,
      unitId,
      title: "Bridge simulator",
      kind: "online",
      appActivity: true,
      systemPrompt: "Build a bridge that sags under trucks.",
      mission: {
        gate: "The mechanism runs once with default settings.",
        freedoms: ["the river", "the trucks' colors"],
        invariants: ["A longer span sags more under the same truck"],
      },
    });
    const app = (await t.run((ctx) => ctx.db.get(appId))) as Doc<"activities">;
    expect(app).toMatchObject({ kind: "online", appActivity: true });
    expect(app.deliverable).toMatchObject({ kind: "artifact", mode: "auto", criteria: [] });
    expect(app.buildContract).toEqual({
      invariants: ["A longer span sags more under the same truck"],
      freedoms: ["the river", "the trucks' colors"],
      gate: "The mechanism runs once with default settings.",
    });
    const [learning] = await activitiesIn(t, lessonId);
    expect(learning.buildContract).toEqual({
      invariants: [],
      freedoms: ["which trucks"],
      gate: "A first table of loads and sags exists.",
    });
  });

  test("an app activity's mission with a gate and no invariants is accepted; without a gate it needs one", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, lessonId } = await seedQuest(t);
    await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId,
      scholarId,
      unitId,
      title: "Find the rule",
      kind: "online",
      systemPrompt: "Work out how span length changes sag.",
    });
    const laterLessonId = await t.run((ctx) =>
      ctx.db.insert("lessons", { unitId, title: "Build", order: 1 }),
    );
    const appId = await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId: laterLessonId,
      scholarId,
      unitId,
      title: "Bridge simulator",
      kind: "online",
      appActivity: true,
      systemPrompt: "Build a bridge that sags under trucks.",
      mission: { gate: "A truck crosses once.", freedoms: ["the river"] },
    });
    const app = (await t.run((ctx) => ctx.db.get(appId))) as Doc<"activities">;
    expect(app.buildContract).toEqual({
      invariants: [],
      freedoms: ["the river"],
      gate: "A truck crosses once.",
    });
    await expect(
      t.mutation(internal.activities.aiCreateForIsUnit, {
        lessonId: laterLessonId,
        scholarId,
        unitId,
        title: "Another simulator",
        kind: "online",
        appActivity: true,
        systemPrompt: "Build it.",
        mission: { freedoms: ["the river"] },
      }),
    ).rejects.toThrow(/1–5 "must be true"/);
  });

  test("a non-app mission with invariants is refused", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, lessonId } = await seedQuest(t);
    await expect(
      t.mutation(internal.activities.aiCreateForIsUnit, {
        lessonId,
        scholarId,
        unitId,
        title: "Find the rule",
        kind: "online",
        systemPrompt: "Work out how span length changes sag.",
        mission: { invariants: ["Longer spans sag more"] },
      }),
    ).rejects.toThrow(/deliverable's criteria/);
  });
});

describe("units.aiSetIsUnitMission", () => {
  test("only the Quest's author may set it", async () => {
    const t = convexTest(schema, modules);
    const { otherScholarId, unitId } = await seedQuest(t);
    await expect(
      t.mutation(internal.units.aiSetIsUnitMission, {
        unitId,
        scholarId: otherScholarId,
        text: "Find out why bridges sag",
        gate: "My first sag table exists",
      }),
    ).rejects.toThrow(/not your IS unit/);
  });

  test("limits: text ≤ 140, gate ≤ 240", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId } = await seedQuest(t);
    await expect(
      t.mutation(internal.units.aiSetIsUnitMission, {
        unitId,
        scholarId,
        text: "x".repeat(141),
        gate: "ok",
      }),
    ).rejects.toThrow(/140/);
    await expect(
      t.mutation(internal.units.aiSetIsUnitMission, {
        unitId,
        scholarId,
        text: "ok",
        gate: "x".repeat(241),
      }),
    ).rejects.toThrow(/240/);
  });

  test("a change needs the scholar's own words, kept as changedBecause", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId } = await seedQuest(t);
    await t.mutation(internal.units.aiSetIsUnitMission, {
      unitId,
      scholarId,
      text: "  Find out why bridges sag  ",
      gate: "My first sag table exists",
    });
    let unit = await t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.mission).toMatchObject({
      text: "Find out why bridges sag",
      gate: "My first sag table exists",
    });
    expect(unit?.mission?.changedBecause).toBeUndefined();

    await expect(
      t.mutation(internal.units.aiSetIsUnitMission, {
        unitId,
        scholarId,
        text: "Build the strongest bridge",
        gate: "A bridge holds one truck",
      }),
    ).rejects.toThrow(
      "This Quest already has a mission; only change it when the scholar asks to.",
    );

    await t.mutation(internal.units.aiSetIsUnitMission, {
      unitId,
      scholarId,
      text: "Build the strongest bridge",
      gate: "A bridge holds one truck",
      scholarWords: "can we change my mission to building the strongest one",
    });
    unit = await t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.mission).toMatchObject({
      text: "Build the strongest bridge",
      changedBecause: "can we change my mission to building the strongest one",
    });
  });
});

// ── The tutor's co-design tools, against a recording ctx ──────────────────

function toolState(): TutorToolSessionState {
  return {
    assistantMsgId: "message",
    fullContent: "",
    lastPersistLength: 0,
    completionHadPreToolText: false,
    rubricHadPreToolText: false,
    completionPreToolClosingIsValid: false,
    rubricPreToolClosingIsValid: false,
    suppressCompletionFollowUp: false,
    activityCompletedThisStream: false,
    createdCodeArtifact: false,
  };
}

async function coDesignTools(runMutation: ReturnType<typeof vi.fn>) {
  const scholarId = "scholar" as Id<"users">;
  const lookup = getFunctionName(
    internal.appAiDirector.directableCharacterForSession,
  );
  const ctx = {
    runMutation,
    runQuery: (ref: Parameters<ActionCtx["runQuery"]>[0]) =>
      getFunctionName(ref) === lookup ? Promise.resolve(null) : Promise.resolve(null),
  } as unknown as ActionCtx;
  return await makeTutorSessionTools(ctx, () => {}, {
    session: {
      scholarId,
      sessionMode: "conversation",
      artifactData: null,
      appStateContext: null,
    } as Parameters<typeof makeTutorSessionTools>[2]["session"],
    projId: "session" as Id<"sessions">,
    callerUserId: scholarId,
    state: toolState(),
    splitAfterTool: async () => {},
    hasProcess: false,
    hasRubric: false,
    activityWasAlreadyComplete: false,
    hasConversationCompletion: false,
    hasActivityResources: false,
    hasPhysicalEnv: false,
    isAngleKickoff: false,
    isOwnIsUnit: true,
    ownIsUnitId: "unit" as Id<"units">,
    instructionPlatform: "web",
    chatPracticeOn: false,
    teachBackOn: false,
  });
}

describe("tutor co-design tools", () => {
  test("create_activity kind app writes the app shape and the mission", async () => {
    const runMutation = vi.fn().mockResolvedValue("activity");
    const tools = await coDesignTools(runMutation);
    const tool = tools.find((x) => x.name === "create_activity")!;
    await tool.run({
      lessonId: "lesson",
      title: "Bridge simulator",
      kind: "app",
      systemPrompt: "Build a bridge that sags under trucks.",
      mission: { gate: "It runs once", freedoms: ["the river"], invariants: ["Longer spans sag more"] },
    } as never);
    expect(getFunctionName(runMutation.mock.calls[0][0])).toBe(
      getFunctionName(internal.activities.aiCreateForIsUnit),
    );
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      kind: "online",
      appActivity: true,
      mission: { gate: "It runs once", freedoms: ["the river"], invariants: ["Longer spans sag more"] },
    });
  });

  test("create_activity surfaces the B6 refusal so the model can act on it", async () => {
    const runMutation = vi
      .fn()
      .mockRejectedValue(new Error(QUEST_BUILD_NEEDS_LEARNING_STEP));
    const tools = await coDesignTools(runMutation);
    const tool = tools.find((x) => x.name === "create_activity")!;
    const reply = await tool.run({
      lessonId: "lesson",
      title: "Bridge simulator",
      kind: "app",
      systemPrompt: "Build it.",
    } as never);
    expect(String(reply)).toContain("Add a learning step first");
  });

  test("set_quest_mission is offered in the Quest's own co-design set and calls the mutation", async () => {
    const runMutation = vi.fn().mockResolvedValue(null);
    const tools = await coDesignTools(runMutation);
    const tool = tools.find((x) => x.name === "set_quest_mission");
    expect(tool).toBeDefined();
    await tool!.run({ text: "Find out why bridges sag", gate: "My sag table exists" } as never);
    expect(getFunctionName(runMutation.mock.calls[0][0])).toBe(
      getFunctionName(internal.units.aiSetIsUnitMission),
    );
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      unitId: "unit",
      scholarId: "scholar",
      text: "Find out why bridges sag",
      gate: "My sag table exists",
    });
  });
});

// ── The Curriculum Bot writes a mission on a non-app activity (B5.4) ──────

function actionCtxFor(t: T): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
  } as unknown as ActionCtx;
}

describe("Curriculum Bot mission on a non-app activity", () => {
  test("gate + freedoms is written; invariants are refused", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, unitId } = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "Lehua Torres",
        username: `teacher-${crypto.randomUUID()}`,
        role: "teacher",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Stories from the shore",
        isActive: true,
      });
      await ctx.db.insert("lessons", { unitId, title: "Narratives", order: 0 });
      return { teacherId, unitId };
    });
    const tools = (await assembleUnitDesignerTools(actionCtxFor(t), () => {}, {
      teacherId,
      unitId,
      role: "teacher",
    })) as Array<{ name: string; run: (a: Record<string, unknown>) => Promise<unknown> }>;
    const create = tools.find((x) => x.name === "create_activity")!;
    const deliverable = {
      kind: "text",
      prompt: "Write the story of one moment at the shore.",
      mode: "auto",
      criteria: [],
    };

    await create.run({
      lessonTitle: "Narratives",
      title: "A shore story",
      kind: "online",
      systemPrompt: "Help them draft a narrative.",
      deliverable,
      buildContract: {
        gate: "A first draft of the whole story exists, however rough",
        freedoms: ["which moment you pick", "funny or serious"],
      },
    });
    const row = await t.run(async (ctx) =>
      (await ctx.db.query("activities").collect()).find((a) => a.title === "A shore story"),
    );
    expect(row?.buildContract).toEqual({
      invariants: [],
      freedoms: ["which moment you pick", "funny or serious"],
      gate: "A first draft of the whole story exists, however rough",
    });

    const refused = await create.run({
      lessonTitle: "Narratives",
      title: "Another shore story",
      kind: "online",
      systemPrompt: "Help them draft a narrative.",
      deliverable,
      buildContract: {
        invariants: ["The story has a beginning, middle and end"],
        freedoms: [],
      },
    });
    expect(String(refused)).toMatch(/deliverable's criteria/);
    const none = await t.run(async (ctx) =>
      (await ctx.db.query("activities").collect()).find((a) => a.title === "Another shore story"),
    );
    expect(none).toBeFalsy();
  });
});

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import schema from "../schema";
import { makeCustomAppTools } from "../lib/customAppTools";
import type { AideEmit } from "../lib/aideStream";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const APP_HTML = "<!doctype html><html><body>Force explorer</body></html>";
const BUILD_BRIEF =
  "Let the scholar demonstrate how force and mass change acceleration. Begin with prediction, then let them vary one quantity at a time and explain the pattern before naming F=ma. Let the scholar choose the cart scenario.";

function actionCtx(t: TestConvex<typeof schema>): ActionCtx {
  const query = t.query as (ref: unknown, args: unknown) => Promise<unknown>;
  const mutation = t.mutation as (
    ref: unknown,
    args: unknown,
  ) => Promise<unknown>;
  return {
    runQuery: (ref: unknown, args: unknown) => query(ref, args),
    runMutation: (ref: unknown, args: unknown) => mutation(ref, args),
  } as unknown as ActionCtx;
}

async function runTool(
  tool: unknown,
  input: Record<string, unknown>,
): Promise<string> {
  return String(
    await (
      tool as { run: (args: Record<string, unknown>) => Promise<unknown> }
    ).run(input),
  );
}

async function seedClass(t: TestConvex<typeof schema>) {
  const institutionId = await seedTestInstitution(t, {
    name: "Voyager Academy",
    slug: `voyager-${Math.random().toString(36).slice(2, 8)}`,
  });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    name: "Lehua Torres",
    username: `lehua-${Math.random().toString(36).slice(2, 8)}`,
  });
  const scholarA = await seedScholarInInstitution(t, {
    institutionId,
    name: "Koa Test",
    username: `koa-${Math.random().toString(36).slice(2, 8)}`,
  });
  const scholarB = await seedScholarInInstitution(t, {
    institutionId,
    name: "Malia Test",
    username: `malia-${Math.random().toString(36).slice(2, 8)}`,
  });
  const groupId = await t.run((ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Honu",
      scholarIds: [scholarA, scholarB],
    }),
  );
  return {
    institutionId,
    teacherId,
    scholarIds: [scholarA, scholarB],
    groupId,
  };
}

async function seedInstalledStaticApp(
  t: TestConvex<typeof schema>,
  args: {
    teacherId: Id<"users">;
    scholarIds: Id<"users">[];
    name?: string;
  },
) {
  return await t.mutation(internal.customApps.createStaticApp, {
    name: args.name ?? "Force Explorer",
    html: APP_HTML,
    token: `token-${Math.random().toString(36).slice(2)}`,
    callerUserId: args.teacherId,
    scholarIds: args.scholarIds,
    groupIds: [],
    allowedScholarIds: args.scholarIds,
    scholarLensResolved: true,
  });
}

async function coachedTool(
  t: TestConvex<typeof schema>,
  args: {
    teacherId: Id<"users">;
    scholarIds: Id<"users">[];
    emit?: AideEmit;
  },
) {
  const tools = await makeCustomAppTools(
    actionCtx(t),
    args.emit ?? vi.fn(),
    {
      role: "teacher",
      callerUserId: args.teacherId,
      linkBase: "https://rabbithole.test",
      allowedScholarIds: new Set(args.scholarIds),
      scholarLensResolved: true,
    },
  );
  return tools.find(
    (tool) => tool.name === "make_app_a_coached_activity",
  )!;
}

describe("make_app_a_coached_activity", () => {
  test("creates a coached starter activity and pushes it live to the group", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const app = await seedInstalledStaticApp(t, fixtures);
    const emit = vi.fn();
    const tool = await coachedTool(t, { ...fixtures, emit });

    const reply = await runTool(tool, {
      appName: "force explorer",
      title: "Investigate Force and Motion",
      unitTitle: "Force and Motion Lab",
      lessonTitle: "Cart Experiments",
      buildBrief: BUILD_BRIEF,
      groupName: "Honu",
    });

    const state = await t.run(async (ctx) => {
      const units = await ctx.db.query("units").collect();
      const unit = units.find((row) => row.title === "Force and Motion Lab");
      const lessons = unit
        ? await ctx.db
            .query("lessons")
            .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
            .collect()
        : [];
      const lesson = lessons.find((row) => row.title === "Cart Experiments");
      const activities = lesson
        ? await ctx.db
            .query("activities")
            .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
            .collect()
        : [];
      const assignments = unit
        ? await ctx.db
            .query("assignments")
            .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
            .collect()
        : [];
      return { unit, lesson, activity: activities[0], assignment: assignments[0] };
    });

    expect(state.unit?.teacherId).toBe(fixtures.teacherId);
    expect(state.lesson?.title).toBe("Cart Experiments");
    expect(state.activity).toMatchObject({
      title: "Investigate Force and Motion",
      kind: "vibecode",
      systemPrompt: BUILD_BRIEF,
      starterAppId: app.customAppId,
      scholarsStartFrom: "starter",
    });
    // No explicit Fable ask → the fleet tutor default, not Fable.
    expect(state.activity?.tutorModel).toBeUndefined();
    expect(state.assignment?.scholarIds).toEqual(fixtures.scholarIds);
    expect(state.assignment?.activitySchedule).toHaveLength(1);
    expect(state.assignment?.activitySchedule?.[0]).toMatchObject({
      activityId: state.activity?._id,
      mode: "classFocus",
    });
    expect(state.assignment?.activitySchedule?.[0].setAt).toBeDefined();
    expect(reply).toContain("Honu (classFocus)");
    expect(reply).toContain(app.url);
    expect(reply).toContain(
      `/teacher/curriculum/${state.unit?._id}/edit?lesson=${state.lesson?._id}&activity=${state.activity?._id}`,
    );
    expect(reply).toContain(`/teacher/schedule/${state.assignment?._id}`);
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "make_app_a_coached_activity",
        result: "Investigate Force and Motion live (classFocus) for 2 scholars",
      },
    });
  });

  test("delivers live to the exact scholarNames cohort", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    await seedInstalledStaticApp(t, fixtures);
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, {
      appName: "Force Explorer",
      buildBrief: BUILD_BRIEF,
      scholarNames: ["Malia Test"],
    });

    const assignments = await t.run((ctx) =>
      ctx.db.query("assignments").collect(),
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0].scholarIds).toEqual([fixtures.scholarIds[1]]);
    expect(assignments[0].activitySchedule).toHaveLength(1);
    expect(assignments[0].activitySchedule?.[0]).toMatchObject({
      mode: "classFocus",
    });
    expect(assignments[0].activitySchedule?.[0].setAt).toBeDefined();
    expect(reply).toContain("Malia Test (classFocus)");
  });

  test("reuses the unit, lesson, activity, starter-origin app, and assignment", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const starterAppId = await t.run((ctx) =>
      ctx.db.insert("customApps", {
        token: "starter-token",
        name: "Momentum Sandbox",
        kind: "static",
        status: "live",
        html: APP_HTML,
        origin: "starter",
        createdBy: fixtures.teacherId,
        updatedAt: Date.now(),
      }),
    );
    const tool = await coachedTool(t, fixtures);
    const input = {
      appName: "Momentum Sandbox",
      title: "Momentum Lab",
      unitTitle: "Momentum",
      lessonTitle: "Collisions",
      buildBrief: BUILD_BRIEF,
      groupName: "Honu",
      mode: "homework",
      tutorModel: "sonnet",
    };

    await runTool(tool, input);
    const secondReply = await runTool(tool, input);

    const state = await t.run(async (ctx) => ({
      units: await ctx.db.query("units").collect(),
      lessons: await ctx.db.query("lessons").collect(),
      activities: await ctx.db.query("activities").collect(),
      assignments: await ctx.db.query("assignments").collect(),
    }));
    expect(state.units.filter((row) => row.title === "Momentum")).toHaveLength(1);
    expect(
      state.lessons.filter((row) => row.title === "Collisions"),
    ).toHaveLength(1);
    const activities = state.activities.filter(
      (row) => row.title === "Momentum Lab",
    );
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      starterAppId,
      scholarsStartFrom: "starter",
      systemPrompt: BUILD_BRIEF,
    });
    expect(activities[0].tutorModel).toBeUndefined();
    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0].activitySchedule).toHaveLength(1);
    expect(state.assignments[0].activitySchedule?.[0].mode).toBe("homework");
    expect(state.assignments[0].activitySchedule?.[0].setAt).toBeDefined();
    expect(secondReply).toContain("Reused coached activity");
  });

  test.each([
    {
      label: "coded",
      app: {
        token: "coded-token",
        name: "Force Explorer",
        kind: "coded" as const,
        status: "live" as const,
        routePath: "/custom-apps/force-explorer",
      },
      expected: /coded app, not a static app/i,
    },
    {
      label: "archived",
      app: {
        token: "archived-token",
        name: "Force Explorer",
        kind: "static" as const,
        status: "archived" as const,
        html: APP_HTML,
      },
      expected: /archived, not live/i,
    },
    {
      label: "missing HTML",
      app: {
        token: "empty-token",
        name: "Force Explorer",
        kind: "static" as const,
        status: "live" as const,
      },
      expected: /no usable HTML/i,
    },
  ])("refuses a $label app", async ({ app, expected }) => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    await t.run((ctx) =>
      ctx.db.insert("customApps", {
        ...app,
        createdBy: fixtures.teacherId,
        updatedAt: Date.now(),
      }),
    );
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, {
      appName: "Force Explorer",
      buildBrief: BUILD_BRIEF,
      groupName: "Honu",
    });

    expect(reply).toMatch(expected);
    expect(
      await t.run((ctx) => ctx.db.query("units").collect()),
    ).toHaveLength(0);
  });

  test("refuses ambiguous in-lens app names before creating curriculum", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    await seedInstalledStaticApp(t, fixtures);
    await seedInstalledStaticApp(t, fixtures);
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, {
      appName: "Force Explorer",
      buildBrief: BUILD_BRIEF,
      groupName: "Honu",
    });

    expect(reply).toMatch(/more than one custom app/i);
    expect(
      await t.run((ctx) => ctx.db.query("units").collect()),
    ).toHaveLength(0);
  });

  test("refuses an app whose live reach is outside the caller's lens", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const otherInstitution = await seedTestInstitution(t, {
      name: "Other Academy",
      slug: `other-${Math.random().toString(36).slice(2, 8)}`,
    });
    const outsideScholar = await seedScholarInInstitution(t, {
      institutionId: otherInstitution,
      name: "Outside Scholar",
      username: `outside-${Math.random().toString(36).slice(2, 8)}`,
    });
    await t.run(async (ctx) => {
      const externalAppId = await ctx.db.insert("externalApps", {
        name: "Force Explorer",
        webUrl: "/custom-apps?token=outside-token",
        createdBy: fixtures.teacherId,
      });
      await ctx.db.insert("customApps", {
        token: "outside-token",
        name: "Force Explorer",
        kind: "static",
        status: "live",
        html: APP_HTML,
        externalAppId,
        createdBy: fixtures.teacherId,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("scholarApps", {
        scholarId: outsideScholar,
        appId: externalAppId,
        enabled: true,
        source: "manual",
      });
    });
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, {
      appName: "Force Explorer",
      buildBrief: BUILD_BRIEF,
      groupName: "Honu",
    });

    expect(reply).toContain('No custom app named "Force Explorer"');
    expect(reply).toContain("current institution view");
    expect(
      await t.run((ctx) => ctx.db.query("units").collect()),
    ).toHaveLength(0);
  });

  test("refuses a co-teacher's zero-reach starter app in the same institution", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const coTeacherId = await seedStaffWithMembership(t, {
      institutionId: fixtures.institutionId,
      name: "Nohea Teacher",
      username: `nohea-${Math.random().toString(36).slice(2, 8)}`,
    });
    await t.run((ctx) =>
      ctx.db.insert("customApps", {
        token: "co-teacher-starter",
        name: "Shared Force Explorer",
        kind: "static",
        status: "live",
        html: APP_HTML,
        origin: "starter",
        createdBy: coTeacherId,
        updatedAt: Date.now(),
      }),
    );
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, {
      appName: "Shared Force Explorer",
      buildBrief: BUILD_BRIEF,
      groupName: "Honu",
    });

    expect(reply).toContain('No custom app named "Shared Force Explorer"');
    expect(
      await t.run((ctx) => ctx.db.query("units").collect()),
    ).toHaveLength(0);
  });

  test("leaves a same-title non-vibecode activity unchanged", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    await seedInstalledStaticApp(t, fixtures);
    const existing = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: fixtures.teacherId,
        institutionId: fixtures.institutionId,
        title: "Force Explorer Lab",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Explore Force Explorer",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Force Explorer",
        kind: "offline",
        systemPrompt: "Original facilitation notes.",
        order: 0,
      });
      return { activityId };
    });
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, {
      appName: "Force Explorer",
      buildBrief: BUILD_BRIEF,
      groupName: "Honu",
    });

    expect(reply).toContain("left unchanged");
    const activity = await t.run((ctx) => ctx.db.get(existing.activityId));
    expect(activity).toMatchObject({
      kind: "offline",
      systemPrompt: "Original facilitation notes.",
    });
    expect(activity?.starterAppId).toBeUndefined();
    expect(activity?.scholarsStartFrom).toBeUndefined();
    expect(
      await t.run((ctx) => ctx.db.query("assignments").collect()),
    ).toHaveLength(0);
  });

  test("creates a coached activity draft without assigning it when no roster is named", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const app = await seedInstalledStaticApp(t, fixtures);
    const emit = vi.fn();
    const tool = await coachedTool(t, { ...fixtures, emit });

    const reply = await runTool(tool, {
      appName: "Force Explorer",
      buildBrief: BUILD_BRIEF,
    });

    const state = await t.run(async (ctx) => ({
      units: await ctx.db.query("units").collect(),
      lessons: await ctx.db.query("lessons").collect(),
      activities: await ctx.db.query("activities").collect(),
      assignments: await ctx.db.query("assignments").collect(),
    }));
    expect(state.units).toHaveLength(1);
    expect(state.lessons).toHaveLength(1);
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      title: "Force Explorer",
      kind: "vibecode",
      systemPrompt: BUILD_BRIEF,
      starterAppId: app.customAppId,
      scholarsStartFrom: "starter",
    });
    // No explicit Fable ask → the fleet tutor default, not Fable.
    expect(state.activities[0]?.tutorModel).toBeUndefined();
    expect(state.assignments).toHaveLength(0);
    expect(reply).toContain(
      `/teacher/curriculum/${state.units[0]._id}/preflight?lesson=${state.lessons[0]._id}&activity=${state.activities[0]._id}&surface=columns&rehearse=manual`,
    );
    expect(reply).toContain(
      "Open that link and you land in the Workshop with the tutor",
    );
    expect(reply).toContain("Nothing was sent to scholars");
    expect(reply).not.toContain("sent it live");
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "make_app_a_coached_activity",
        result: "Force Explorer created, not sent",
      },
    });
  });

  // ── Move A: appRequest build hand-off (no existing app) ─────────────────
  const APP_REQUEST =
    "A rocket shop where scholars pick parts, then run a launch that counts down and animates.";

  test("drafts a build hand-off activity from appRequest — appRequest field carries the request, no starter, no assignment", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const emit = vi.fn();
    const tool = await coachedTool(t, { ...fixtures, emit });

    const reply = await runTool(tool, {
      appRequest: APP_REQUEST,
      title: "Rocket Shop",
      buildBrief: BUILD_BRIEF,
    });

    const state = await t.run(async (ctx) => ({
      units: await ctx.db.query("units").collect(),
      lessons: await ctx.db.query("lessons").collect(),
      activities: await ctx.db.query("activities").collect(),
      assignments: await ctx.db.query("assignments").collect(),
    }));
    expect(state.units).toHaveLength(1);
    expect(state.lessons).toHaveLength(1);
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      title: "Rocket Shop",
      kind: "vibecode",
      systemPrompt: BUILD_BRIEF,
      appRequest: APP_REQUEST,
    });
    // No explicit Fable ask → the fleet tutor default, not Fable.
    expect(state.activities[0]?.tutorModel).toBeUndefined();
    // The request rides the dedicated, never-scholar-facing field — NOT the
    // teacher `description` that buildActivitySection emits into tutor prompts.
    expect(state.activities[0].description).toBeUndefined();
    // The whole point of the hand-off: no starter yet — the teacher builds it.
    expect(state.activities[0].starterAppId).toBeUndefined();
    expect(state.activities[0].scholarsStartFrom).toBeUndefined();
    expect(state.assignments).toHaveLength(0);
    expect(reply).toContain(
      `/teacher/curriculum/${state.units[0]._id}/preflight?lesson=${state.lessons[0]._id}&activity=${state.activities[0]._id}&surface=columns`,
    );
    expect(reply).toContain("builds the first version with you in the Workshop");
    expect(reply).not.toContain("sent it live");
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "make_app_a_coached_activity",
        result: "Rocket Shop drafted for building",
      },
    });
  });

  test("errors when neither appName nor appRequest is provided", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, { buildBrief: BUILD_BRIEF });

    expect(reply).toMatch(/exactly one is required/i);
    expect(
      await t.run((ctx) => ctx.db.query("units").collect()),
    ).toHaveLength(0);
  });

  test("refuses a roster on the appRequest build hand-off (nothing to send yet)", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, {
      appRequest: APP_REQUEST,
      buildBrief: BUILD_BRIEF,
      groupName: "Honu",
    });

    expect(reply).toMatch(/nothing to send yet/i);
    expect(
      await t.run((ctx) => ctx.db.query("units").collect()),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("assignments").collect()),
    ).toHaveLength(0);
  });

  test("rejects both appName and appRequest (XOR) before writing anything", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    await seedInstalledStaticApp(t, fixtures);
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, {
      appName: "Force Explorer",
      appRequest: APP_REQUEST,
      buildBrief: BUILD_BRIEF,
    });

    expect(reply).toBe("Give either appName or appRequest, not both.");
    // Nothing is created — the guard runs before any cohort/app resolution.
    expect(
      await t.run((ctx) => ctx.db.query("units").collect()),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("activities").collect()),
    ).toHaveLength(0);
  });

  // ── Move A: build hand-off reuse safety on the no-app path ───────────────
  test("reuses a same-title PLAIN DRAFT vibecode activity and updates its appRequest", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const tool = await coachedTool(t, fixtures);

    await runTool(tool, {
      appRequest: APP_REQUEST,
      title: "Rocket Shop",
      buildBrief: BUILD_BRIEF,
    });
    const NEW_REQUEST =
      "A rocket shop, but scholars can also name their rocket and save a fleet.";
    const reply = await runTool(tool, {
      appRequest: NEW_REQUEST,
      title: "Rocket Shop",
      buildBrief: BUILD_BRIEF,
    });

    const activities = await t.run((ctx) =>
      ctx.db.query("activities").collect(),
    );
    expect(activities).toHaveLength(1);
    expect(activities[0].appRequest).toBe(NEW_REQUEST);
    expect(reply).toMatch(/Reused/);
  });

  test("refuses to reuse a same-title vibecode activity that already has a starter", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const app = await seedInstalledStaticApp(t, fixtures);

    // Existing coached activity built from a real app (starter + start-from).
    // Explicit unit/lesson titles so both calls land in the SAME lesson (the
    // reuse-safety check only fires on a same-title activity in that lesson).
    await runTool(await coachedTool(t, fixtures), {
      appName: "Force Explorer",
      title: "Rocket Shop",
      unitTitle: "Rocket Unit",
      lessonTitle: "Rocket Lesson",
      buildBrief: BUILD_BRIEF,
    });

    const reply = await runTool(await coachedTool(t, fixtures), {
      appRequest: APP_REQUEST,
      title: "Rocket Shop",
      unitTitle: "Rocket Unit",
      lessonTitle: "Rocket Lesson",
      buildBrief: BUILD_BRIEF,
    });

    expect(reply).toMatch(/PARTIAL/);
    expect(reply).toMatch(/different activity title/i);
    const activities = await t.run((ctx) =>
      ctx.db.query("activities").collect(),
    );
    // Untouched: still the starter-backed activity, no appRequest written.
    expect(activities).toHaveLength(1);
    expect(activities[0].starterAppId).toBe(app.customAppId);
    expect(activities[0].appRequest).toBeUndefined();
  });

  test("refuses to reuse a same-title draft that is already referenced by an assignment", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    const tool = await coachedTool(t, fixtures);

    // Draft a plain build hand-off, then wire an assignment schedule entry to
    // it (simulating a promotion that went live) without adding a starter.
    await runTool(tool, {
      appRequest: APP_REQUEST,
      title: "Rocket Shop",
      buildBrief: BUILD_BRIEF,
    });
    await t.run(async (ctx) => {
      const activity = (await ctx.db.query("activities").collect())[0];
      await ctx.db.insert("assignments", {
        teacherId: fixtures.teacherId,
        unitId: (await ctx.db.query("units").collect())[0]._id,
        scholarIds: fixtures.scholarIds,
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: activity._id, mode: "classFocus", setAt: Date.now() },
        ],
      });
    });

    const reply = await runTool(tool, {
      appRequest: "A totally different app.",
      title: "Rocket Shop",
      buildBrief: BUILD_BRIEF,
    });

    expect(reply).toMatch(/PARTIAL/);
    const activities = await t.run((ctx) =>
      ctx.db.query("activities").collect(),
    );
    // Untouched: the original request stands, the new one was not written.
    expect(activities).toHaveLength(1);
    expect(activities[0].appRequest).toBe(APP_REQUEST);
  });
});

// TRA-477: a teacher's game handed to scholars landed with no editAccess,
// which reads as "always" — every scholar could remix it.
describe("make_app_a_coached_activity scholar edit policy", () => {
  const activityTitled = (t: TestConvex<typeof schema>, title: string) =>
    t.run(async (ctx) =>
      (await ctx.db.query("activities").collect()).find(
        (row) => row.title === title,
      ),
    );

  test("an existing app defaults to play (never) on a new activity", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    await seedInstalledStaticApp(t, fixtures);
    const tool = await coachedTool(t, fixtures);

    await runTool(tool, {
      appName: "Force Explorer",
      title: "Play Force Explorer",
      buildBrief: BUILD_BRIEF,
    });
    expect((await activityTitled(t, "Play Force Explorer"))?.editAccess).toBe(
      "never",
    );
  });

  test("each scholarEdit value maps to its stored policy", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    await seedInstalledStaticApp(t, fixtures);
    const tool = await coachedTool(t, fixtures);

    for (const [scholarEdit, stored] of [
      ["play", "never"],
      ["afterCompletion", "afterCompletion"],
      ["build", "always"],
    ] as const) {
      await runTool(tool, {
        appName: "Force Explorer",
        title: `Force Explorer ${scholarEdit}`,
        buildBrief: BUILD_BRIEF,
        scholarEdit,
      });
      expect(
        (await activityTitled(t, `Force Explorer ${scholarEdit}`))?.editAccess,
      ).toBe(stored);
    }

    // The build hand-off (appRequest) takes the same arg.
    await runTool(tool, {
      appRequest: "A gecko that climbs when you spell a long-e word.",
      title: "Gecko climb",
      buildBrief: BUILD_BRIEF,
      scholarEdit: "build",
    });
    expect((await activityTitled(t, "Gecko climb"))?.editAccess).toBe("always");
  });

  test("a reused activity keeps its policy unless one is passed", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    await seedInstalledStaticApp(t, fixtures);
    const tool = await coachedTool(t, fixtures);
    const input = {
      appName: "Force Explorer",
      title: "Reused explorer",
      buildBrief: BUILD_BRIEF,
    };

    await runTool(tool, { ...input, scholarEdit: "build" });
    await runTool(tool, input);
    expect((await activityTitled(t, "Reused explorer"))?.editAccess).toBe(
      "always",
    );
    await runTool(tool, { ...input, scholarEdit: "play" });
    expect((await activityTitled(t, "Reused explorer"))?.editAccess).toBe(
      "never",
    );
  });

  test("an unknown scholarEdit is refused before anything is created", async () => {
    const t = convexTest(schema, modules);
    const fixtures = await seedClass(t);
    await seedInstalledStaticApp(t, fixtures);
    const tool = await coachedTool(t, fixtures);

    const reply = await runTool(tool, {
      appName: "Force Explorer",
      buildBrief: BUILD_BRIEF,
      scholarEdit: "remix",
    });
    expect(reply).toMatch(/^Not created/);
    expect(
      await t.run(async (ctx) => (await ctx.db.query("units").collect()).length),
    ).toBe(0);
  });
});

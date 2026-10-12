import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  makeCustomAppTools,
  CUSTOM_APPS_SYSTEM_PROMPT_SECTION,
} from "../lib/customAppTools";
import {
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const CALLER = "user_1" as Id<"users">;
const fakeCtx = {} as unknown as ActionCtx;
const noopEmit = () => {};

function stubCtx(overrides: {
  runQuery?: ReturnType<typeof vi.fn>;
  runMutation?: ReturnType<typeof vi.fn>;
}): ActionCtx {
  return {
    runQuery: overrides.runQuery ?? vi.fn(),
    runMutation: overrides.runMutation ?? vi.fn(),
    runAction: vi.fn(),
    scheduler: { runAfter: vi.fn() },
  } as unknown as ActionCtx;
}

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
): Promise<unknown> {
  return (
    tool as { run: (args: Record<string, unknown>) => Promise<unknown> }
  ).run(input);
}

const toolNames = async (role: Parameters<typeof makeCustomAppTools>[2]["role"]) =>
  (
    await makeCustomAppTools(fakeCtx, noopEmit, {
      role,
      callerUserId: CALLER,
      sessionId: null,
    })
  )
    .map((t) => t.name)
    .sort();

afterEach(() => {
  delete process.env.INTROSPECTION_ENABLED;
});

describe("makeCustomAppTools gating", () => {
  test("returns [] for a scholar", async () => {
    expect(await toolNames("scholar")).toEqual([]);
  });

  // Installing an app FOR a scholar is a teaching action, so the two
  // non-teaching staff roles get nothing — matching their curated no-scholar/
  // no-learning-writes tool sets in aideTools.test.ts.
  test("returns [] for non-teaching staff (curriculum_designer, staff)", async () => {
    expect(await toolNames("curriculum_designer")).toEqual([]);
    expect(await toolNames("staff")).toEqual([]);
  });

  test("returns the custom-app tools for every teacher role", async () => {
    for (const role of ["teacher", "school_admin", "platform_admin"] as const) {
      expect(await toolNames(role)).toEqual([
        "create_custom_app",
        "fork_activity",
        "install_external_app",
        "make_app_a_coached_activity",
        "update_custom_app",
      ]);
    }
  });

  test("describes the configured deployment URL for static apps", async () => {
    const tools = await makeCustomAppTools(fakeCtx, noopEmit, {
      role: "teacher",
      callerUserId: CALLER,
      sessionId: null,
    });
    const tool = tools.find((candidate) => candidate.name === "create_custom_app");
    if (
      !tool ||
      !("description" in tool) ||
      typeof tool.description !== "string"
    ) {
      throw new Error("create_custom_app is missing its description");
    }
    expect(tool.description).toContain(
      "https://rabbithole.test/custom-apps?token=",
    );
    const htmlDescription = (
      tool as unknown as {
        input_schema: {
          properties: { html: { description: string } };
        };
      }
    ).input_schema.properties.html.description;
    expect(htmlDescription).toContain("window.rabbithole.setState");
    expect(tool.description).not.toContain("example.invalid");
  });
});

describe("custom-app write behavior", () => {
  test("fork_activity returns the new manual rehearsal link", async () => {
    const runMutation = vi.fn().mockResolvedValue({
      unitId: "unit_fork",
      unitTitle: "Force explorer Lab",
      lessonId: "lesson_fork",
      activityId: "activity_fork",
      activityTitle: "Force explorer",
    });
    const emit = vi.fn();
    const tools = await makeCustomAppTools(
      stubCtx({ runMutation }),
      emit,
      {
        role: "teacher",
        callerUserId: CALLER,
        sessionId: null,
        linkBase: "https://rabbithole.test",
      },
    );
    const tool = tools.find((candidate) => candidate.name === "fork_activity")!;
    const sourceLink =
      "https://rabbithole.test/teacher/curriculum/source/preflight?activity=activity_source";

    const result = String(await runTool(tool, { activity: sourceLink }));

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      {
        callerUserId: CALLER,
        activityId: "activity_source",
      },
    );
    expect(result).toContain(
      "https://rabbithole.test/teacher/curriculum/unit_fork/preflight?lesson=lesson_fork&activity=activity_fork&surface=columns&rehearse=manual",
    );
    expect(result).toContain("the fork gets its own copy");
    expect(result).toContain(
      "resources and process links remain shared references",
    );
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "fork_activity",
        result: "Forked Force explorer",
      },
    });
  });

  test("fork_activity rejects a foreign-institution activity link", async () => {
    const t = convexTest(schema, modules);
    const institutionA = await seedTestInstitution(t, {
      name: "Moli School",
      slug: "aide-fork-source-school",
      isPrimary: true,
    });
    const institutionB = await seedTestInstitution(t, {
      name: "Kona Tutoring",
      slug: "aide-fork-caller-school",
    });
    const sourceTeacherId = await seedStaffWithMembership(t, {
      institutionId: institutionA,
      name: "Lehua Torres",
      username: "aide-fork-source-staff",
    });
    const callerId = await seedStaffWithMembership(t, {
      institutionId: institutionB,
      name: "Noe Alana",
      username: "aide-fork-foreign-caller",
    });
    const activityId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: sourceTeacherId,
        institutionId: institutionA,
        title: "Institution A Physics",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Forces",
        order: 0,
      });
      return await ctx.db.insert("activities", {
        lessonId,
        title: "Force explorer",
        kind: "online",
        order: 0,
      });
    });
    const tools = await makeCustomAppTools(
      actionCtx(t),
      noopEmit,
      {
        role: "teacher",
        callerUserId: callerId,
        sessionId: null,
        linkBase: "https://rabbithole.test",
      },
    );
    const tool = tools.find((candidate) => candidate.name === "fork_activity")!;

    const result = String(
      await runTool(tool, {
        activity: `https://rabbithole.test/teacher/curriculum/source/preflight?activity=${activityId}`,
      }),
    );

    expect(result).toMatch(/forbidden|institution/i);
    expect(
      await t.run(async (ctx) => {
        const units = await ctx.db
          .query("units")
          .withIndex("by_teacher", (q) => q.eq("teacherId", callerId))
          .collect();
        return units.length;
      }),
    ).toBe(0);
  });

  test("fork_activity resolves a unique activity name before forking", async () => {
    const runQuery = vi.fn().mockResolvedValue([
      {
        kind: "activity",
        unitId: "source_unit",
        unitTitle: "Shared physics",
        lessonId: "source_lesson",
        lessonTitle: "Forces",
        activityId: "activity_source",
        activityTitle: "Force explorer",
      },
    ]);
    const runMutation = vi.fn().mockResolvedValue({
      unitId: "unit_fork",
      unitTitle: "Force explorer Lab",
      lessonId: "lesson_fork",
      activityId: "activity_fork",
      activityTitle: "Force explorer",
    });
    const tools = await makeCustomAppTools(
      stubCtx({ runQuery, runMutation }),
      noopEmit,
      {
        role: "teacher",
        callerUserId: CALLER,
        sessionId: null,
      },
    );
    const tool = tools.find((candidate) => candidate.name === "fork_activity")!;

    const result = String(
      await runTool(tool, { activity: "Force explorer" }),
    );

    expect(runQuery).toHaveBeenCalledWith(
      expect.anything(),
      {
        callerUserId: CALLER,
        query: "Force explorer",
        limit: 30,
      },
    );
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      {
        callerUserId: CALLER,
        activityId: "activity_source",
      },
    );
    expect(result).toContain("rehearse=manual");
  });

  test("refuses an ambiguous scholar partial instead of installing for the first match", async () => {
    const runQuery = vi.fn().mockResolvedValue({
      scholars: [
        { id: "scholar_kai_h" as Id<"users">, name: "Kai Hale" },
        { id: "scholar_kai_w" as Id<"users">, name: "Kai Wong" },
      ],
      extendedEducationOmitted: 0,
    });
    const runMutation = vi.fn();
    const tools = await makeCustomAppTools(
      stubCtx({ runQuery, runMutation }),
      noopEmit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "create_custom_app")!;

    const result = String(
      await runTool(tool, {
        purpose: "standalone_tile",
        name: "Fraction Tiles",
        html: "<!doctype html><h1>Fractions</h1>",
        scholarNames: ["Kai"],
      }),
    );

    expect(result).toContain('Multiple scholars match "Kai"');
    expect(result).toContain("Kai Hale, Kai Wong");
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("update_custom_app updates a static app in place", async () => {
    const runMutation = vi.fn().mockResolvedValue({
      kind: "updated",
      name: "Fraction Tiles",
      token: "stable-token",
      url: "https://rabbithole.test/custom-apps?token=stable-token",
      status: "live",
    });
    const emit = vi.fn();
    const tools = await makeCustomAppTools(
      stubCtx({ runMutation }),
      emit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "update_custom_app")!;
    const html = "<!doctype html><h1>Updated fractions</h1>";

    const result = String(
      await runTool(tool, { name: "fraction tiles", html }),
    );

    // The lens args are part of the mutation's contract now: updateStaticApp
    // fails CLOSED without them, so a caller that stops threading them is a
    // regression this assertion must catch.
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      {
        name: "fraction tiles",
        html,
        callerUserId: CALLER,
        allowedScholarIds: undefined,
        scholarLensResolved: false,
      },
    );
    expect(result).toContain("Updated **Fraction Tiles** in place");
    expect(result).toContain("stable-token");
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "update_custom_app",
        result: "Updated Fraction Tiles",
      },
    });
  });

  test("update_custom_app threads the caller's institution lens", async () => {
    // The security fix lives or dies on this hand-off: updateStaticApp scopes
    // its name scan by the lens the TOOL passes, so a lens resolved upstream
    // must arrive intact (as an array, not the Set the tool holds).
    const runMutation = vi.fn().mockResolvedValue({
      kind: "updated",
      name: "Fraction Tiles",
      token: "stable-token",
      url: "https://rabbithole.test/custom-apps?token=stable-token",
      status: "live",
    });
    const scholar = "user_scholar_1" as Id<"users">;
    const tools = await makeCustomAppTools(stubCtx({ runMutation }), noopEmit, {
      role: "teacher",
      callerUserId: CALLER,
      sessionId: null,
      allowedScholarIds: new Set([scholar]),
    });
    const tool = tools.find(
      (candidate) => candidate.name === "update_custom_app",
    )!;

    await runTool(tool, { name: "Fraction Tiles", html: "<!doctype html><p>x" });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        callerUserId: CALLER,
        allowedScholarIds: [scholar],
        scholarLensResolved: true,
      }),
    );
  });

  test("update_custom_app refuses ambiguous app names", async () => {
    const runMutation = vi.fn().mockResolvedValue({ kind: "ambiguous" });
    const tools = await makeCustomAppTools(
      stubCtx({ runMutation }),
      noopEmit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "update_custom_app")!;

    const result = String(
      await runTool(tool, {
        name: "Timer",
        html: "<!doctype html><h1>Timer</h1>",
      }),
    );

    expect(result).toMatch(/more than one custom app/i);
  });

  test("update_custom_app refuses oversize HTML before mutation", async () => {
    const runMutation = vi.fn();
    const tools = await makeCustomAppTools(
      stubCtx({ runMutation }),
      noopEmit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "update_custom_app")!;

    const result = String(
      await runTool(tool, {
        name: "Timer",
        html: "x".repeat(700 * 1024 + 1),
      }),
    );

    expect(result).toMatch(/too large/i);
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("reports the durable planned assignment when the live push fails", async () => {
    const scholar = "scholar_1" as Id<"users">;
    const runQuery = vi.fn().mockImplementation((ref) => {
      const name = getFunctionName(ref);
      if (name === "curriculumAssistant:listScholarGroupsInternal") {
        return Promise.resolve([
          {
            id: "group_1",
            name: "Honu",
            members: [{ id: scholar, name: "Koa Test" }],
          },
        ]);
      }
      if (name === "customApps:resolveStaticAppForCoachedActivity") {
        return Promise.resolve({
          kind: "resolved",
          customAppId: "app_1",
          name: "Force Explorer",
          url: "https://rabbithole.test/custom-apps?token=force",
        });
      }
      if (name === "activities:listByLessonInternal") {
        return Promise.resolve([]);
      }
      throw new Error(`Unexpected query ${name}`);
    });
    const runMutation = vi.fn().mockImplementation((ref) => {
      const name = getFunctionName(ref);
      if (name === "teacherAide:createCurriculumUnit") {
        return Promise.resolve({ unitId: "unit_1", existed: false });
      }
      if (name === "teacherAide:createScholarLesson") {
        return Promise.resolve({ lessonId: "lesson_1", existed: false });
      }
      if (name === "teacherAide:createScholarActivity") {
        return Promise.resolve({
          activityId: "activity_1",
          existed: false,
          kind: "vibecode",
        });
      }
      if (name === "assignments:aideAssignWork") {
        return Promise.resolve({
          assignmentId: "assignment_1",
          created: true,
        });
      }
      if (name === "assignments:aidePushActivityNow") {
        return Promise.reject(new Error("push unavailable"));
      }
      throw new Error(`Unexpected mutation ${name}`);
    });
    const tools = await makeCustomAppTools(
      stubCtx({ runQuery, runMutation }),
      noopEmit,
      {
        role: "teacher",
        callerUserId: CALLER,
        allowedScholarIds: new Set([scholar]),
      },
    );
    const tool = tools.find(
      (candidate) => candidate.name === "make_app_a_coached_activity",
    )!;

    const result = String(
      await runTool(tool, {
        appName: "Force Explorer",
        buildBrief: "Coach a prediction-observation-explanation arc.",
        groupName: "Honu",
      }),
    );

    expect(result).toContain("PARTIAL:");
    expect(result).toContain("/teacher/schedule/assignment_1");
    expect(result).toContain("PLANNED");
    expect(result).toContain("Scholars do NOT see it yet");
    expect(result).toContain("push unavailable");
  });

  test("reports the durable curriculum state when assignment creation fails", async () => {
    const scholar = "scholar_1" as Id<"users">;
    const runQuery = vi.fn().mockImplementation((ref) => {
      const name = getFunctionName(ref);
      if (name === "curriculumAssistant:listScholarGroupsInternal") {
        return Promise.resolve([
          {
            id: "group_1",
            name: "Honu",
            members: [{ id: scholar, name: "Koa Test" }],
          },
        ]);
      }
      if (name === "customApps:resolveStaticAppForCoachedActivity") {
        return Promise.resolve({
          kind: "resolved",
          customAppId: "app_1",
          name: "Force Explorer",
          url: "https://rabbithole.test/custom-apps?token=force",
        });
      }
      if (name === "activities:listByLessonInternal") {
        return Promise.resolve([]);
      }
      throw new Error(`Unexpected query ${name}`);
    });
    const runMutation = vi.fn().mockImplementation((ref) => {
      const name = getFunctionName(ref);
      if (name === "teacherAide:createCurriculumUnit") {
        return Promise.resolve({ unitId: "unit_1", existed: false });
      }
      if (name === "teacherAide:createScholarLesson") {
        return Promise.resolve({ lessonId: "lesson_1", existed: false });
      }
      if (name === "teacherAide:createScholarActivity") {
        return Promise.resolve({
          activityId: "activity_1",
          existed: false,
          kind: "vibecode",
        });
      }
      if (name === "assignments:aideAssignWork") {
        return Promise.reject(new Error("assignment unavailable"));
      }
      throw new Error(`Unexpected mutation ${name}`);
    });
    const tools = await makeCustomAppTools(
      stubCtx({ runQuery, runMutation }),
      noopEmit,
      {
        role: "teacher",
        callerUserId: CALLER,
        allowedScholarIds: new Set([scholar]),
      },
    );
    const tool = tools.find(
      (candidate) => candidate.name === "make_app_a_coached_activity",
    )!;

    const result = String(
      await runTool(tool, {
        appName: "Force Explorer",
        buildBrief: "Coach a prediction-observation-explanation arc.",
        groupName: "Honu",
      }),
    );

    expect(result).toContain("PARTIAL:");
    expect(result).toContain("/teacher/curriculum/unit_1");
    expect(result).toContain(
      "/teacher/curriculum/unit_1/edit?lesson=lesson_1",
    );
    expect(result).toContain(
      "/teacher/curriculum/unit_1/edit?lesson=lesson_1&activity=activity_1",
    );
    expect(result).toContain("no assignment was created");
    expect(result).toContain("assignment unavailable");
    expect(
      runMutation.mock.calls.map(([ref]) => getFunctionName(ref)),
    ).not.toContain("assignments:aidePushActivityNow");
  });

});

describe("CUSTOM_APPS_SYSTEM_PROMPT_SECTION", () => {
  test("names the available tools so the model can choose and revise", () => {
    expect(CUSTOM_APPS_SYSTEM_PROMPT_SECTION).toContain("install_external_app");
    expect(CUSTOM_APPS_SYSTEM_PROMPT_SECTION).toContain("create_custom_app");
    expect(CUSTOM_APPS_SYSTEM_PROMPT_SECTION).toContain(
      "make_app_a_coached_activity",
    );
    expect(CUSTOM_APPS_SYSTEM_PROMPT_SECTION).toContain("update_custom_app");
    expect(CUSTOM_APPS_SYSTEM_PROMPT_SECTION).toContain("kids to USE");
    expect(CUSTOM_APPS_SYSTEM_PROMPT_SECTION).toContain("kids BUILD");
  });
});

describe("create_custom_app purpose guard", () => {
  test("refuses to build an app meant for a coached activity and routes to the hand-off", async () => {
    const runQuery = vi.fn();
    const runMutation = vi.fn();
    const tools = await makeCustomAppTools(
      stubCtx({ runQuery, runMutation }),
      noopEmit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "create_custom_app")!;

    const result = String(
      await runTool(tool, {
        purpose: "coached_activity",
        name: "The rocket shop",
        html: "<!doctype html><h1>Rocket</h1>",
      }),
    );

    expect(result).toContain("make_app_a_coached_activity");
    expect(result).toContain("appRequest");
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("refuses when no purpose is declared", async () => {
    const runMutation = vi.fn();
    const tools = await makeCustomAppTools(
      stubCtx({ runQuery: vi.fn(), runMutation }),
      noopEmit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "create_custom_app")!;

    const result = String(
      await runTool(tool, { name: "Timer", html: "<!doctype html><p>t" }),
    );

    expect(result).toContain("purpose");
    expect(runMutation).not.toHaveBeenCalled();
  });
});

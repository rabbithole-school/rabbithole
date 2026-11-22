/**
 * One subject matcher (TRA-723). A unit's subject and a timetable class's
 * name are free text. The scholar's subject tabs now match them through
 * `unitSubjectFitsClass`, as class filing does, so a "Social Studies" unit
 * lands on a "Humanities" tab. The aide's create_unit also has to name a
 * real subject, so new units can be matched at all.
 */
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import {
  resolveScholarWorkSubject,
  type ScholarTimetableContext,
} from "../assignments";
import { assembleCurriculumTools } from "../lib/aideTools";
import { ROLES } from "../lib/roles";
import { unitSubjectInput } from "../lib/unitSubject";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Tool = {
  name: string;
  run: (input: Record<string, unknown>) => Promise<string>;
};

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

async function seedWorld(t: TestConvex<typeof schema>) {
  const world = await makeWorld(t, {
    schools: 1,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const school = world.schools[0];
  return { school, scholar: school.scholars[0] };
}

describe("a scholar's subject tab follows the unit's subject by meaning", () => {
  const assignmentId = "assignment1" as Id<"assignments">;
  const activityId = "activity1" as Id<"activities">;
  const timetable = (
    subjectTabs: string[],
    placementSubject?: string,
  ): ScholarTimetableContext => ({
    periodId: null,
    groupIds: [],
    placements: [] as Doc<"schedulePlacements">[],
    subjectTabs,
    subjectByWork: new Map<string, string>(
      placementSubject
        ? [[`${assignmentId}::${activityId}`, placementSubject] as [string, string]]
        : [],
    ),
  });

  test("a Social Studies unit with no filed class lands on the Humanities tab", () => {
    expect(
      resolveScholarWorkSubject(
        timetable(["Humanities", "Math Workshop"]),
        assignmentId,
        activityId,
        "Social Studies",
        null,
      ),
    ).toBe("Humanities");
    expect(
      resolveScholarWorkSubject(
        timetable(["Humanities", "Math Workshop"]),
        assignmentId,
        activityId,
        "Mathematics",
      ),
    ).toBe("Math Workshop");
  });

  test("a unit that fits two tabs keeps the old answer instead of guessing", () => {
    // No placement: Other (null), as before the matcher.
    expect(
      resolveScholarWorkSubject(
        timetable(["Science", "Art"]),
        assignmentId,
        activityId,
        "Science & Art",
      ),
    ).toBeNull();
    // With a placement: the placement's subject, as before.
    expect(
      resolveScholarWorkSubject(
        timetable(["Science", "Art"], "Art"),
        assignmentId,
        activityId,
        "Science & Art",
      ),
    ).toBe("Art");
  });

  test("an exact spelling wins over another tab that also fits", () => {
    expect(
      resolveScholarWorkSubject(
        timetable(["Humanities", "Social Studies"]),
        assignmentId,
        activityId,
        "Social Studies",
      ),
    ).toBe("Social Studies");
  });

  test("the filed class still comes first", () => {
    expect(
      resolveScholarWorkSubject(
        timetable(["Humanities", "Art"]),
        assignmentId,
        activityId,
        "Social Studies",
        "Art",
      ),
    ).toBe("Art");
  });
});

describe("the aide's create_unit requires a subject", () => {
  async function createUnitTool(t: TestConvex<typeof schema>) {
    const { school } = await seedWorld(t);
    const tools = (await assembleCurriculumTools(actionCtx(t), () => {}, {
      role: ROLES.TEACHER,
      callerUserId: school.teacher.id,
      surface: "private",
    })) as unknown as Tool[];
    const tool = tools.find((x) => x.name === "create_unit");
    if (!tool) throw new Error("missing create_unit");
    return { tool, school };
  }

  test("without a real subject (missing, blank or a placeholder) it asks again and creates nothing", async () => {
    const t = convexTest(schema, modules);
    const { tool, school } = await createUnitTool(t);
    const before = await t.run((ctx) => ctx.db.query("units").collect());

    for (const subject of [undefined, "   ", "General", " N/A ", "na", "None", "other", "Misc", "miscellaneous", "TBD", "unknown"]) {
      const raw = await tool.run({ title: "Tide Pool Ecosystems", subject });
      const res = JSON.parse(raw) as { created?: boolean; error?: string };
      expect(res.created).toBe(false);
      expect(res.error).toContain("call create_unit again");
    }

    const after = await t.run((ctx) => ctx.db.query("units").collect());
    expect(after.length).toBe(before.length);
    expect(
      after.some(
        (u) => u.title === "Tide Pool Ecosystems" && u.teacherId === school.teacher.id,
      ),
    ).toBe(false);
  });

  test("with a subject it creates the unit with that subject", async () => {
    const t = convexTest(schema, modules);
    const { tool } = await createUnitTool(t);
    const raw = await tool.run({
      title: "Tide Pool Ecosystems",
      subject: " Science ",
    });
    const res = JSON.parse(raw) as { unitId: Id<"units">; existed: boolean };
    expect(res.existed).toBe(false);
    const unit = await t.run((ctx) => ctx.db.get(res.unitId));
    expect(unit?.title).toBe("Tide Pool Ecosystems");
    expect(unit?.subject).toBe("Science");
  });
});

describe("a unit named for its subject", () => {
  test("any real subject is kept, including one the alias table doesn't list", () => {
    expect(unitSubjectInput("Robotics")).toBe("Robotics");
    expect(unitSubjectInput(" Math ")).toBe("Math");
  });

  test.each(["Robotics", "Math"])("create_unit accepts %s as both title and subject", async (name) => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const tools = (await assembleCurriculumTools(actionCtx(t), () => {}, {
      role: ROLES.TEACHER,
      callerUserId: school.teacher.id,
      surface: "private",
    })) as unknown as Tool[];
    const tool = tools.find((x) => x.name === "create_unit");
    if (!tool) throw new Error("missing create_unit");
    const res = JSON.parse(
      await tool.run({ title: name, subject: name }),
    ) as { unitId: Id<"units"> };
    const unit = await t.run((ctx) => ctx.db.get(res.unitId));
    expect(unit?.subject).toBe(name);
  });
});

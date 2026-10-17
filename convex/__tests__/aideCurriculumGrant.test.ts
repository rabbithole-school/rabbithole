import { convexTest, type TestConvex } from "convex-test";
import { getFunctionName } from "convex/server";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { assembleCurriculumTools } from "../lib/aideTools";
import { ROLES } from "../lib/roles";
import { makeLesson, makeUnit, makeWorld } from "./factories/world";
import { grantInstitutionMembership } from "./institutionTestHelpers";

/**
 * A base `staff` account holding a per-school `curriculum:edit` grant can
 * build curriculum in the UI (`requireUnitEditAccess`). The aide now hands it
 * the same authoring tools — and every one of them must stop at the same
 * per-unit boundary the UI does: its own school's general units only, never
 * another school's, never a scholar's Quest unit.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Tool = { name: string; run: (input: Record<string, unknown>) => Promise<string> };

function actionCtx(t: TestConvex<typeof schema>): ActionCtx {
  const query = t.query as (ref: unknown, args: unknown) => Promise<unknown>;
  const mutation = t.mutation as (ref: unknown, args: unknown) => Promise<unknown>;
  return {
    runQuery: (ref: unknown, args: unknown) =>
      getFunctionName(ref as Parameters<typeof getFunctionName>[0]).includes(":canOffer")
        ? Promise.resolve(false)
        : query(ref, args),
    runMutation: (ref: unknown, args: unknown) => mutation(ref, args),
  } as unknown as ActionCtx;
}

async function seed(t: TestConvex<typeof schema>) {
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const [home, other] = world.schools;
  // Grant-ONLY staff: a staff membership + `curriculum:edit`, no
  // `school:operations` — so no access to the school's scholars. (The
  // factory's makeStaff("staff") is operations staff, whose scholar access
  // legitimately reaches a Quest unit, as it does in the UI.)
  const designerId = await t.run((ctx) =>
    ctx.db.insert("users", {
      role: "staff",
      name: "Sloane Kahale",
      username: "sloane-curriculum",
    }),
  );
  await grantInstitutionMembership(t, designerId, home.id, "staff");
  const designer = { id: designerId };
  await t.run(async (ctx) => {
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: designer.id,
      institutionId: home.id,
      capability: "curriculum:edit",
      grantedBy: home.admin.id,
      grantedAt: Date.now(),
    });
  });
  const homeUnit = await makeUnit(t, home.teacher, home, { title: "Future Creatures" });
  const homeLesson = await makeLesson(t, homeUnit, { title: "Medium tutorials" });
  const otherUnit = await makeUnit(t, other.teacher, other, { title: "Tide Pools" });
  const otherLesson = await makeLesson(t, otherUnit, { title: "Anemones" });
  const scholar = home.scholars[0];
  const questUnit = await makeUnit(t, scholar.id, home, {
    title: "Word Detective",
    authorScholarId: scholar.id,
  });
  const tools = (await assembleCurriculumTools(actionCtx(t), () => {}, {
    role: ROLES.STAFF,
    callerUserId: designer.id,
    surface: "private",
  })) as unknown as Tool[];
  const tool = (name: string) => {
    const found = tools.find((x) => x.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };
  return {
    designer,
    home,
    homeUnit,
    homeLesson,
    otherUnit,
    otherLesson,
    questUnit,
    tool,
  };
}

const lessonTitles = (t: TestConvex<typeof schema>, unitId: Id<"units">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect()
    ).map((l) => l.title),
  );

describe("aide curriculum tools for a staff curriculum:edit grant", () => {
  test("builds lessons and activities in a unit of the grant's school", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const lesson = JSON.parse(
      await s.tool("create_scholar_lesson").run({
        unitId: s.homeUnit,
        title: "Colored pencil refresher",
      }),
    ) as { lessonId?: string };
    expect(lesson.lessonId).toBeTruthy();

    const activity = JSON.parse(
      await s.tool("create_scholar_activity").run({
        lessonId: lesson.lessonId,
        title: "Layering practice",
        kind: "offline",
      }),
    ) as { activityId?: string; error?: string };
    expect(activity.error).toBeUndefined();
    expect(activity.activityId).toBeTruthy();
  });

  test("refuses another school's unit and lesson, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const lessonResult = await s.tool("create_scholar_lesson").run({
      unitId: s.otherUnit,
      title: "Should not land",
    });
    expect(lessonResult).toMatch(/^Refused:/);
    expect(await lessonTitles(t, s.otherUnit)).toEqual(["Anemones"]);

    const activityResult = await s.tool("create_scholar_activity").run({
      lessonId: s.otherLesson,
      title: "Should not land",
      kind: "offline",
    });
    expect(activityResult).toMatch(/^Refused:/);
    const activities = await t.run((ctx) =>
      ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", s.otherLesson))
        .collect(),
    );
    expect(activities).toHaveLength(0);

    const kindResult = await s.tool("create_problem_set").run({
      lessonId: s.otherLesson,
      title: "Should not land",
      grade: "3",
    });
    expect(kindResult).toMatch(/Refused:/);

    const details = await s.tool("get_unit_details").run({ unitTitle: "Tide Pools" });
    expect(details).not.toContain(s.otherUnit);
  });

  test("refuses a scholar's Quest unit in its own school", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const result = await s.tool("create_scholar_lesson").run({
      unitId: s.questUnit,
      title: "Should not land",
    });
    expect(result).toMatch(/^Refused:/);
    expect(await lessonTitles(t, s.questUnit)).toEqual([]);
  });

  test("move_lesson checks both ends", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    // Out of the grant's school.
    expect(
      await s.tool("move_lesson").run({
        lessonId: s.homeLesson,
        targetUnitId: s.otherUnit,
      }),
    ).toMatch(/Refused:/);
    // In from another school.
    expect(
      await s.tool("move_lesson").run({
        lessonId: s.otherLesson,
        targetUnitId: s.homeUnit,
      }),
    ).toMatch(/Refused:/);
    expect(await lessonTitles(t, s.otherUnit)).toEqual(["Anemones"]);
    expect(await lessonTitles(t, s.homeUnit)).toEqual(["Medium tutorials"]);
  });

  test("list_units shows only the grant school's general units", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const rows = await t.query(internal.curriculumAssistant.listUnitsInternal, {
      callerUserId: s.designer.id,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(s.homeUnit);
    expect(ids).not.toContain(s.otherUnit);
    expect(ids).not.toContain(s.questUnit);
  });

  test("a grant at one school cannot edit the primary school's unstamped legacy unit", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 0,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [primary, guest] = world.schools;
    // Staff at BOTH schools; the guest membership is older, so it is the
    // active school — and the only one the grant covers.
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { role: "staff", name: "Hoku Makani", username: "hoku-dual" }),
    );
    await grantInstitutionMembership(t, userId, guest.id, "staff");
    await grantInstitutionMembership(t, userId, primary.id, "staff");
    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: userId,
        institutionId: guest.id,
        capability: "curriculum:edit",
        grantedBy: guest.admin.id,
        grantedAt: Date.now(),
      });
    });
    // Pre-tenancy unit: no institutionId, so it belongs to the primary school.
    const legacyUnit = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: primary.teacher.id,
        title: "Legacy Catalog",
        isActive: true,
      }),
    );

    const res = await t.query(internal.curriculumAssistant.checkUnitEditAccessForAide, {
      callerUserId: userId,
      unitId: legacyUnit,
    });
    expect(res.ok).toBe(false);
  });

  test("a suspended school shrinks the staff toolset instead of failing the turn", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.home.id, { disabledAt: Date.now() }));

    const tools = await assembleCurriculumTools(actionCtx(t), () => {}, {
      role: ROLES.STAFF,
      callerUserId: s.designer.id,
      surface: "private",
    });
    const names = tools.map((x) => x.name);
    expect(names).not.toContain("create_scholar_lesson");
    expect(names).not.toContain("create_unit");
  });

  test("a malformed id refuses legibly instead of throwing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await t.query(internal.curriculumAssistant.checkUnitEditAccessForAide, {
      callerUserId: s.designer.id,
      unitId: "not-an-id",
    });
    expect(res.ok).toBe(false);
  });
});

describe("aide unit scoping for curriculum roles (TRA-532)", () => {
  test("a teacher's aide lists and rehearses only their own school's units", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [home, other] = world.schools;
    const homeUnit = await makeUnit(t, home.teacher, home, { title: "Reef Survey" });
    const otherUnit = await makeUnit(t, other.teacher, other, { title: "Volcano Watch" });
    const otherQuest = await makeUnit(t, other.scholars[0].id, other, {
      title: "Secret Quest",
      authorScholarId: other.scholars[0].id,
    });

    const rows = await t.query(internal.curriculumAssistant.listUnitsInternal, {
      callerUserId: home.teacher.id,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(homeUnit);
    expect(ids).not.toContain(otherUnit);
    expect(ids).not.toContain(otherQuest);

    const tools = (await assembleCurriculumTools(actionCtx(t), () => {}, {
      role: ROLES.TEACHER,
      callerUserId: home.teacher.id,
      surface: "private",
    })) as unknown as Tool[];
    const rehearse = tools.find((x) => x.name === "rehearse_activity")!;
    // Another school's unit no longer resolves by title at all.
    const res = await rehearse.run({ unitTitle: "Volcano Watch", activityTitle: "Any" });
    expect(res).not.toMatch(/Started/);
    expect(res).toMatch(/No unit found/);
  });
});

describe("unit tenancy regressions to rule out", () => {
  test("a platform admin with no scope still lists every school's units", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 0,
      parentsPerSchool: 0,
      includePlatformAdmin: true,
    });
    const [home, other] = world.schools;
    const homeUnit = await makeUnit(t, home.teacher, home, { title: "Reef Survey" });
    const otherUnit = await makeUnit(t, other.teacher, other, { title: "Volcano Watch" });
    const ids = (
      await t.query(internal.curriculumAssistant.listUnitsInternal, {
        callerUserId: world.platformAdmin!.id,
      })
    ).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([homeUnit, otherUnit]));
  });

  test("a curriculum:edit grant at the primary school still edits its unstamped units", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 0,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [primary] = world.schools;
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { role: "staff", name: "Lehua Torres", username: "lehua-grant" }),
    );
    await grantInstitutionMembership(t, userId, primary.id, "staff");
    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: userId,
        institutionId: primary.id,
        capability: "curriculum:edit",
        grantedBy: primary.admin.id,
        grantedAt: Date.now(),
      });
    });
    const legacyUnit = await t.run((ctx) =>
      ctx.db.insert("units", { teacherId: primary.teacher.id, title: "Legacy", isActive: true }),
    );
    const res = await t.query(internal.curriculumAssistant.checkUnitEditAccessForAide, {
      callerUserId: userId,
      unitId: legacyUnit,
    });
    expect(res).toEqual({ ok: true });
  });

  test("assigning another school's unit by id is refused, in the UI and the aide", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [home, other] = world.schools;
    const otherUnit = await makeUnit(t, other.teacher, other, {
      title: "Volcano Watch",
      unpublished: true,
    });
    const asTeacher = await world.as.staffOf(home);
    await expect(
      asTeacher.mutation(api.assignments.assignWork, {
        unitId: otherUnit,
        scholarIds: [home.scholars[0].id],
        startsAt: Date.now(),
        target: { kind: "unit" },
      }),
    ).rejects.toThrow(/not in your institution/i);

    const tools = (await assembleCurriculumTools(actionCtx(t), () => {}, {
      role: ROLES.TEACHER,
      callerUserId: home.teacher.id,
      surface: "private",
    })) as unknown as Tool[];
    const assign = tools.find((x) => x.name === "assign_unit")!;
    const res = await assign
      .run({ unitId: otherUnit, scholarNames: [home.scholars[0].name] })
      .catch((e: unknown) => String(e));
    expect(res).not.toMatch(/"assignmentId"/);
    expect(await t.run((ctx) => ctx.db.query("assignments").collect())).toHaveLength(0);
    // Not published into the other school as a side effect.
    expect((await t.run((ctx) => ctx.db.get(otherUnit)))?.unpublished).toBe(true);
  });
});

/**
 * `units.searchCurriculum` — the ⌘K palette's lesson/activity autocomplete.
 *
 * The interesting risk here is NOT "does substring matching work". It is the
 * cross-tenant one CLAUDE.md names: a handler that reads exactly one
 * institution passes the "can A read B's data" question while still being
 * wrong. This query takes a client-supplied `scope`, so the tests below ask
 * the harder question — can a caller name another school's scope, or "all",
 * and be served curriculum they may not open?
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { makeActivity, makeLesson, makeStaff, makeUnit, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/** Two schools, each with a unit → lesson → activity tree whose titles share
 *  the needle "autorotation", plus a plain staffer with no curriculum access. */
async function seedWorld(t: ReturnType<typeof convexTest>) {
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 0,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const homeSchool = world.schools[0];
  const foreignSchool = world.schools[1];

  await t.run(async (ctx) => {
    await ctx.db.patch(homeSchool.id, { slug: "moli" });
    await ctx.db.patch(foreignSchool.id, { name: "Guests", slug: "guests", kind: "guest" });
    await ctx.db.patch(homeSchool.teacher.id, {
      name: "Home teacher",
      username: "home-teacher",
    });
  });

  const designer = homeSchool.ops.id;
  await t.run(async (ctx) => {
    await ctx.db.patch(designer, { name: "Designer", username: "designer" });
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: designer,
      institutionId: homeSchool.id,
      capability: "curriculum:edit",
      grantedBy: homeSchool.teacher.id,
      grantedAt: Date.now(),
    });
  });
  const plainStaff = await makeStaff(t, homeSchool, "staff", {
    name: "Plain staff",
    username: "plain-staff",
  });

  const tree = async (institution: typeof homeSchool, label: string) => {
    const unitId = await makeUnit(t, homeSchool.teacher, institution, {
      title: `${label} unit`,
      subject: "Flight",
      isActive: true,
    });
    const lessonId = await makeLesson(t, unitId, {
      title: `${label} autorotation lesson`,
      order: 0,
    });
    const activityId = await makeActivity(t, lessonId, {
      title: `${label} autorotation drill`,
      kind: "offline",
      order: 0,
    });
    await makeActivity(t, lessonId, {
      title: `Away ${label} autorotation drill`,
      kind: "offline",
      order: 2,
    });
    const archivedId = await makeActivity(t, lessonId, {
      title: `${label} autorotation retired drill`,
      kind: "offline",
      order: 1,
      archivedAt: Date.now(),
    });
    const archivedUnitId = await makeUnit(t, homeSchool.teacher, institution, {
      title: `${label} archived unit`,
      subject: "Flight",
      isActive: false,
    });
    const archivedUnitLessonId = await makeLesson(t, archivedUnitId, {
      title: `${label} autorotation shelved lesson`,
      order: 0,
    });
    return {
      unitId,
      lessonId,
      activityId,
      archivedId,
      archivedUnitId,
      archivedUnitLessonId,
    };
  };

  return {
    world,
    homeSchool,
    foreignSchool,
    plainStaff: plainStaff.id,
    home: await tree(homeSchool, "Home"),
    foreign: await tree(foreignSchool, "Foreign"),
  };
}

const titles = (hits: Array<Record<string, unknown>>) =>
  hits.map((h) => (h.kind === "lesson" ? h.lessonTitle : h.activityTitle));

describe("units.searchCurriculum", () => {
  test("finds a lesson and an activity below the unit the caller can open", async () => {
    const t = convexTest(schema, modules);
    const { world, homeSchool } = await seedWorld(t);
    const asDesigner = await world.as.staffOf(homeSchool, "staff");

    const hits = await asDesigner.query(api.units.searchCurriculum, {
      query: "autorotation",
    });
    expect(titles(hits)).toEqual(
      expect.arrayContaining([
        "Home autorotation lesson",
        "Home autorotation drill",
      ]),
    );
  });

  test("never returns another school's curriculum — not by default, not by naming their scope, not via 'all'", async () => {
    const t = convexTest(schema, modules);
    const { world, homeSchool } = await seedWorld(t);
    const asDesigner = await world.as.staffOf(homeSchool, "staff");

    for (const scope of [undefined, "guests", "all"]) {
      const hits = await asDesigner.query(api.units.searchCurriculum, {
        query: "autorotation",
        ...(scope === undefined ? {} : { scope }),
      });
      expect(
        titles(hits).filter((title) => String(title).startsWith("Foreign")),
      ).toEqual([]);
    }
  });

  test("returns units' children only — units themselves stay the shell's job", async () => {
    const t = convexTest(schema, modules);
    const { world, homeSchool } = await seedWorld(t);
    const asDesigner = await world.as.staffOf(homeSchool, "staff");

    // "Home" matches the unit title AND its lesson/activity titles. The unit
    // must never come back here: the palette already renders units from its
    // own `units.list` subscription, so returning them would double the row.
    const hits = await asDesigner.query(api.units.searchCurriculum, {
      query: "home",
    });
    // Guard against the assertion below passing on an empty array.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.kind === "lesson" || h.kind === "activity")).toBe(
      true,
    );
    expect(titles(hits)).not.toContain("Home unit");
  });

  test("a teacher — the caller the institution lens alone protects — still cannot read another school's curriculum", async () => {
    const t = convexTest(schema, modules);
    const { world, homeSchool } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(homeSchool);

    expect(
      await asTeacher.query(api.users.currentUser, {}),
    ).toMatchObject({ hasCurriculumAccess: true });

    for (const scope of [undefined, "guests", "all"]) {
      const hits = await asTeacher.query(api.units.searchCurriculum, {
        query: "autorotation",
        ...(scope === undefined ? {} : { scope }),
      });
      expect(titles(hits)).toEqual(
        expect.arrayContaining(["Home autorotation lesson"]),
      );
      expect(
        titles(hits).filter((title) => String(title).startsWith("Foreign")),
      ).toEqual([]);
    }
  });

  test("skips the children of archived units", async () => {
    const t = convexTest(schema, modules);
    const { world, homeSchool } = await seedWorld(t);
    const asDesigner = await world.as.staffOf(homeSchool, "staff");

    const hits = await asDesigner.query(api.units.searchCurriculum, {
      query: "autorotation",
    });
    expect(titles(hits)).not.toContain("Home autorotation shelved lesson");
  });

  test("ranks an exact title above substring matches so the cap cannot bury it", async () => {
    const t = convexTest(schema, modules);
    const { world, homeSchool } = await seedWorld(t);
    const asDesigner = await world.as.staffOf(homeSchool, "staff");

    // Two rows match: "Home autorotation drill" exactly, and "Away Home
    // autorotation drill" as a substring — and the latter sorts FIRST
    // alphabetically, so only ranking keeps the exact hit inside the cap.
    const hits = await asDesigner.query(api.units.searchCurriculum, {
      query: "home autorotation drill",
      limit: 1,
    });
    expect(titles(hits)).toEqual(["Home autorotation drill"]);
  });

  test("excludes archived activities", async () => {
    const t = convexTest(schema, modules);
    const { world, homeSchool } = await seedWorld(t);
    const asDesigner = await world.as.staffOf(homeSchool, "staff");

    const hits = await asDesigner.query(api.units.searchCurriculum, {
      query: "retired",
    });
    expect(hits).toEqual([]);
  });

  test("a staffer with no curriculum access gets nothing", async () => {
    const t = convexTest(schema, modules);
    const { plainStaff, world } = await seedWorld(t);
    const asPlainStaff = await world.as.staffOf(
      { ...world.schools[0], ops: { ...world.schools[0].ops, id: plainStaff } },
      "staff",
    );

    expect(
      await asPlainStaff.query(api.users.currentUser, {}),
    ).toMatchObject({ hasCurriculumAccess: false });
    await expect(
      asPlainStaff.query(api.units.searchCurriculum, { query: "autorotation" }),
    ).resolves.toEqual([]);
  });

  test("mirrors the client's 2-character floor", async () => {
    const t = convexTest(schema, modules);
    const { world, homeSchool } = await seedWorld(t);
    const asDesigner = await world.as.staffOf(homeSchool, "staff");

    await expect(
      asDesigner.query(api.units.searchCurriculum, { query: "a" }),
    ).resolves.toEqual([]);
  });

  test("caps the result list", async () => {
    const t = convexTest(schema, modules);
    const { world, homeSchool } = await seedWorld(t);
    const asDesigner = await world.as.staffOf(homeSchool, "staff");

    const hits = await asDesigner.query(api.units.searchCurriculum, {
      query: "autorotation",
      limit: 1,
    });
    expect(hits).toHaveLength(1);
  });
});

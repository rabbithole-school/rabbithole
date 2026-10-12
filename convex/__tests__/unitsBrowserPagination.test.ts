/**
 * `units.listForBrowser` + `units.browserFilterOptions` — the paginated
 * Curriculum → Units column (TRA-468).
 *
 * The risk worth testing is the tenancy boundary, not the pagination
 * arithmetic: the browser now filters a stream BEFORE cutting pages, so the
 * lens (catalog units by `institutionId`, Independent Study units by their
 * author scholar's institution) runs on a different code path than
 * `units.list`'s collect-then-filter. The parity test pins the two to the same
 * unit set; the foreign-school assertions ask the harder question CLAUDE.md
 * names — can a caller name another school's scope and be served its units?
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { makeLesson, makeStaff, makeUnit, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Identity = Awaited<
  ReturnType<Awaited<ReturnType<typeof makeWorld>>["as"]["staffOf"]>
>;

async function seedWorld(t: ReturnType<typeof convexTest>) {
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const home = world.schools[0];
  const foreign = world.schools[1];
  await t.run(async (ctx) => {
    await ctx.db.patch(home.id, { slug: "moli" });
    await ctx.db.patch(foreign.id, { slug: "kona" });
    await ctx.db.patch(home.teacher.id, { name: "Home teacher" });
  });
  const colleague = await makeStaff(t, home, "teacher", {
    name: "Colleague",
    username: "colleague-teacher",
  });

  // Inserted oldest → newest; the browser lists newest first.
  const mineMath = await makeUnit(t, home.teacher, home, {
    title: "Fractions",
    subject: "Math",
  });
  await makeLesson(t, mineMath, { title: "L1", order: 0 });
  await makeLesson(t, mineMath, { title: "L2", order: 1 });
  const mineArchived = await makeUnit(t, home.teacher, home, {
    title: "Old unit",
    subject: "History",
    isActive: false,
  });
  const colleagueScience = await makeUnit(t, colleague, home, {
    title: "Volcanoes",
    subject: " science ",
  });
  const homeIndependentStudy = await makeUnit(t, home.teacher, home, {
    title: "Home scholar's quest",
    authorScholarId: home.scholars[0].id,
  });
  const foreignCatalog = await makeUnit(t, foreign.teacher, foreign, {
    title: "Foreign catalog",
    subject: "Math",
  });
  // An Independent Study unit stamped with the HOME institution but authored
  // by a FOREIGN scholar: its tenant is the author, not the stamp.
  const foreignIndependentStudy = await makeUnit(t, home.teacher, home, {
    title: "Foreign scholar's quest",
    authorScholarId: foreign.scholars[0].id,
  });
  const mineNewest = await makeUnit(t, home.teacher, home, {
    title: "Newest",
    subject: "math",
  });

  return {
    world,
    home,
    foreign,
    colleague,
    units: {
      mineMath,
      mineArchived,
      colleagueScience,
      homeIndependentStudy,
      foreignCatalog,
      foreignIndependentStudy,
      mineNewest,
    },
  };
}

/** Walk every page with a tiny page size, so a multi-page path is exercised. */
async function browseAll(
  as: Identity,
  args: {
    scope?: string;
    authorId?: Id<"users">;
    subject?: string;
    showArchived: boolean;
  },
) {
  const rows = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const result: FunctionReturnType<typeof api.units.listForBrowser> =
      await as.query(api.units.listForBrowser, {
      ...args,
      paginationOpts: { numItems: 2, cursor },
    });
    rows.push(...result.page);
    if (result.isDone) return rows;
    cursor = result.continueCursor;
  }
  throw new Error("pagination never finished");
}

describe("units.listForBrowser", () => {
  test("serves exactly the units.list curriculum set, newest first, across pages", async () => {
    const t = convexTest(schema, modules);
    const { world, home } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(home);

    const full = await asTeacher.query(api.units.list, {});
    const paged = await browseAll(asTeacher, { showArchived: true });
    expect(paged.map((row) => row._id)).toEqual(full.map((row) => row._id));
  });

  test("never serves another school's units, whatever scope is named", async () => {
    const t = convexTest(schema, modules);
    const { world, home, units } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(home);

    for (const scope of [undefined, "", "moli", "kona", "all"]) {
      const ids = (await browseAll(asTeacher, { scope, showArchived: true })).map(
        (row) => row._id,
      );
      expect(ids).not.toContain(units.foreignCatalog);
      expect(ids).not.toContain(units.foreignIndependentStudy);
    }
    const ids = (await browseAll(asTeacher, { showArchived: true })).map(
      (row) => row._id,
    );
    expect(ids).toContain(units.homeIndependentStudy);
    expect(ids[0]).toBe(units.mineNewest);
  });

  test("author, subject, and archived filters run server-side", async () => {
    const t = convexTest(schema, modules);
    const { world, home, colleague, units } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(home);

    const mineActive = await browseAll(asTeacher, {
      authorId: home.teacher.id,
      showArchived: false,
    });
    // The foreign scholar's quest shares this teacherId but stays out (lens).
    expect(mineActive.map((row) => row._id)).toEqual([
      units.mineNewest,
      units.homeIndependentStudy,
      units.mineMath,
    ]);

    const mineWithArchived = await browseAll(asTeacher, {
      authorId: home.teacher.id,
      showArchived: true,
    });
    expect(mineWithArchived.map((row) => row._id)).toContain(units.mineArchived);

    // Case-folded and trimmed, like the old client-side match.
    const math = await browseAll(asTeacher, { subject: "Math", showArchived: false });
    expect(math.map((row) => row._id)).toEqual([units.mineNewest, units.mineMath]);
    const science = await browseAll(asTeacher, {
      subject: "science",
      showArchived: false,
    });
    expect(science.map((row) => row._id)).toEqual([units.colleagueScience]);

    const colleagueOnly = await browseAll(asTeacher, {
      authorId: colleague.id,
      showArchived: false,
    });
    expect(colleagueOnly.map((row) => row._id)).toEqual([units.colleagueScience]);
  });

  test("rows are slim and carry the lesson count", async () => {
    const t = convexTest(schema, modules);
    const { world, home, units } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(home);

    const rows = await browseAll(asTeacher, { showArchived: false });
    const fractions = rows.find((row) => row._id === units.mineMath);
    expect(fractions).toEqual({
      _id: units.mineMath,
      title: "Fractions",
      emoji: null,
      isActive: true,
      unpublished: false,
      teacherId: home.teacher.id,
      teacherName: "Home teacher",
      lessonCount: 2,
    });
  });

  test("a scholar (no curriculum access) gets nothing", async () => {
    const t = convexTest(schema, modules);
    const { world, home } = await seedWorld(t);
    const asScholar = await world.as.scholar(home.scholars[0]);
    const result = await asScholar.query(api.units.listForBrowser, {
      showArchived: true,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page).toEqual([]);
    expect(result.isDone).toBe(true);
  });
});

describe("units.browserFilterOptions", () => {
  test("authors, subjects, and archived count span the lens, not the loaded page", async () => {
    const t = convexTest(schema, modules);
    const { world, home, foreign, colleague } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(home);

    const active = await asTeacher.query(api.units.browserFilterOptions, {
      showArchived: false,
    });
    expect(active.subjects).toEqual(["math", "science"]);
    expect(active.archivedCount).toBe(1);
    const authorIds = active.authors.map((author) => author.id);
    expect(authorIds).toEqual(
      expect.arrayContaining([String(home.teacher.id), String(colleague.id)]),
    );
    expect(authorIds).not.toContain(String(foreign.teacher.id));

    const withArchived = await asTeacher.query(api.units.browserFilterOptions, {
      showArchived: true,
    });
    expect(withArchived.subjects).toEqual(["History", "math", "science"]);

    const foreignScope = await asTeacher.query(api.units.browserFilterOptions, {
      scope: "kona",
      showArchived: true,
    });
    expect(foreignScope.authors.map((author) => author.id)).not.toContain(
      String(foreign.teacher.id),
    );
  });
});

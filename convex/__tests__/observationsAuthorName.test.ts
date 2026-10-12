import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: listByScholar documents authorName as null when the author
// "has no name". A whitespace-only or empty stored name must therefore resolve
// to null so the UI falls back to "A teacher" instead of rendering a blank
// author prefix (" noted — …").

describe("observations author name normalization", () => {
  test("whitespace-only author name resolves to null", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    await t.run((ctx) => ctx.db.patch(school.teacher.id, { name: "   " }));

    await t.run((ctx) =>
      ctx.db.insert("observations", {
        teacherId: school.teacher.id,
        scholarId: school.scholars[0].id,
        note: "Concern about focus.",
        type: "concern",
      }),
    );

    const asTeacher = await world.as.staffOf(school);
    const rows = await asTeacher.query(api.observations.listByScholar, {
      scholarId: school.scholars[0].id,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].authorName).toBeNull();
  });

  test("real author name is preserved", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    await t.run((ctx) =>
      ctx.db.patch(school.teacher.id, { name: "Ms. Kawena" }),
    );

    await t.run((ctx) =>
      ctx.db.insert("observations", {
        teacherId: school.teacher.id,
        scholarId: school.scholars[0].id,
        note: "Great progress.",
        type: "praise",
      }),
    );

    const asTeacher = await world.as.staffOf(school);
    const rows = await asTeacher.query(api.observations.listByScholar, {
      scholarId: school.scholars[0].id,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].authorName).toBe("Ms. Kawena");
  });
});

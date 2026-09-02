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
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** Two schools, each with a unit → lesson → activity tree whose titles share
 *  the needle "autorotation", plus a plain staffer with no curriculum access. */
async function seedWorld(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const moli = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
    });
    const guests = await ctx.db.insert("institutions", {
      name: "Guests",
      slug: "guests",
      kind: "guest",
    });
    const teacher = await ctx.db.insert("users", {
      name: "Teacher",
      username: "teacher",
      role: "teacher",
    });
    const designer = await ctx.db.insert("users", {
      name: "Designer",
      username: "designer",
      role: "staff",
    });
    const plainStaff = await ctx.db.insert("users", {
      name: "Plain staff",
      username: "plain-staff",
      role: "staff",
    });
    // A TEACHER is the important caller: `curriculumAccessInstitutionIds`
    // returns "all" for a curriculum ROLE, so the capability grant stops being
    // a second guard and the institution lens is the ONLY thing standing
    // between them and another school's curriculum.
    const homeTeacher = await ctx.db.insert("users", {
      name: "Home teacher",
      username: "home-teacher",
      role: "teacher",
    });
    for (const membership of [
      { userId: designer, role: "staff" as const, institutionId: moli },
      { userId: plainStaff, role: "staff" as const, institutionId: moli },
      { userId: teacher, role: "teacher" as const, institutionId: moli },
      { userId: homeTeacher, role: "teacher" as const, institutionId: moli },
    ]) {
      await ctx.db.insert("memberships", membership);
    }
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: designer,
      institutionId: moli,
      capability: "curriculum:edit",
      grantedBy: teacher,
      grantedAt: Date.now(),
    });

    const tree = async (
      institutionId: Id<"institutions">,
      label: string,
    ) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: teacher,
        institutionId,
        title: `${label} unit`,
        subject: "Flight",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: `${label} autorotation lesson`,
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: `${label} autorotation drill`,
        kind: "offline",
        order: 0,
      });
      // Sorts alphabetically BEFORE the exact-match title while merely
      // containing it — so a rank-blind sort would return this one first.
      await ctx.db.insert("activities", {
        lessonId,
        title: `Away ${label} autorotation drill`,
        kind: "offline",
        order: 2,
      });
      const archivedId = await ctx.db.insert("activities", {
        lessonId,
        title: `${label} autorotation retired drill`,
        kind: "offline",
        order: 1,
        archivedAt: Date.now(),
      });
      const archivedUnitId = await ctx.db.insert("units", {
        teacherId: teacher,
        institutionId,
        title: `${label} archived unit`,
        subject: "Flight",
        isActive: false,
      });
      const archivedUnitLessonId = await ctx.db.insert("lessons", {
        unitId: archivedUnitId,
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
      designer,
      homeTeacher,
      plainStaff,
      home: await tree(moli, "Home"),
      foreign: await tree(guests, "Foreign"),
    };
  });
}

const titles = (hits: Array<Record<string, unknown>>) =>
  hits.map((h) => (h.kind === "lesson" ? h.lessonTitle : h.activityTitle));

describe("units.searchCurriculum", () => {
  test("finds a lesson and an activity below the unit the caller can open", async () => {
    const t = convexTest(schema, modules);
    const { designer } = await seedWorld(t);
    const asDesigner = await asUser(t, designer);

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
    const { designer } = await seedWorld(t);
    const asDesigner = await asUser(t, designer);

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
    const { designer } = await seedWorld(t);
    const asDesigner = await asUser(t, designer);

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
    const { homeTeacher } = await seedWorld(t);
    const asTeacher = await asUser(t, homeTeacher);

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
    const { designer } = await seedWorld(t);
    const asDesigner = await asUser(t, designer);

    const hits = await asDesigner.query(api.units.searchCurriculum, {
      query: "autorotation",
    });
    expect(titles(hits)).not.toContain("Home autorotation shelved lesson");
  });

  test("ranks an exact title above substring matches so the cap cannot bury it", async () => {
    const t = convexTest(schema, modules);
    const { designer } = await seedWorld(t);
    const asDesigner = await asUser(t, designer);

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
    const { designer } = await seedWorld(t);
    const asDesigner = await asUser(t, designer);

    const hits = await asDesigner.query(api.units.searchCurriculum, {
      query: "retired",
    });
    expect(hits).toEqual([]);
  });

  test("a staffer with no curriculum access gets nothing", async () => {
    const t = convexTest(schema, modules);
    const { plainStaff } = await seedWorld(t);
    const asPlainStaff = await asUser(t, plainStaff);

    expect(
      await asPlainStaff.query(api.users.currentUser, {}),
    ).toMatchObject({ hasCurriculumAccess: false });
    await expect(
      asPlainStaff.query(api.units.searchCurriculum, { query: "autorotation" }),
    ).resolves.toEqual([]);
  });

  test("mirrors the client's 2-character floor", async () => {
    const t = convexTest(schema, modules);
    const { designer } = await seedWorld(t);
    const asDesigner = await asUser(t, designer);

    await expect(
      asDesigner.query(api.units.searchCurriculum, { query: "a" }),
    ).resolves.toEqual([]);
  });

  test("caps the result list", async () => {
    const t = convexTest(schema, modules);
    const { designer } = await seedWorld(t);
    const asDesigner = await asUser(t, designer);

    const hits = await asDesigner.query(api.units.searchCurriculum, {
      query: "autorotation",
      limit: 1,
    });
    expect(hits).toHaveLength(1);
  });
});

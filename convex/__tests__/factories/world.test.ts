import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import {
  makeWorld,
  makeScholar,
  makeStaff,
  makeParent,
  makePlatformAdmin,
  makeSession,
  makeUnit,
  makeLesson,
  makeActivity,
} from "./world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../**/*.ts");

describe("makeWorld", () => {
  test("seeds a schema-valid two-school world by default", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);

    expect(world.schools).toHaveLength(2);
    expect(world.schools[0].isPrimary).toBe(true);
    expect(world.schools[1].isPrimary).toBe(false);
    // Distinct institutions — the trivial cross-tenant default.
    expect(world.schools[0].id).not.toBe(world.schools[1].id);
    expect(world.platformAdmin).toBeDefined();

    for (const school of world.schools) {
      expect(school.scholars).toHaveLength(2);
      expect(school.parents).toHaveLength(1);
      // Every scholar/parent/staff row landed and is schema-valid (convex-test
      // throws on insert if the schema validator rejects the row, so simply
      // reaching this assertion proves validity).
      const scholars = await t.run((ctx) => ctx.db.get(school.scholars[0].id));
      expect(scholars?.role).toBe("scholar");
      expect(scholars?.institutionId).toBe(school.id);

      const teacherRow = await t.run((ctx) => ctx.db.get(school.teacher.id));
      expect(teacherRow?.role).toBe("teacher");
      const adminRow = await t.run((ctx) => ctx.db.get(school.admin.id));
      expect(adminRow?.role).toBe("school_admin");
      const opsRow = await t.run((ctx) => ctx.db.get(school.ops.id));
      expect(opsRow?.role).toBe("staff");

      // Real institution memberships (not just a users.role stamp).
      const teacherMembership = await t.run((ctx) =>
        ctx.db
          .query("memberships")
          .withIndex("by_user_role", (q) =>
            q.eq("userId", school.teacher.id).eq("role", "teacher"),
          )
          .unique(),
      );
      expect(teacherMembership?.institutionId).toBe(school.id);

      // Guardianship links the parent to their child.
      const guardianship = await t.run((ctx) =>
        ctx.db
          .query("guardianships")
          .withIndex("by_parent", (q) =>
            q.eq("parentUserId", school.parents[0].id),
          )
          .unique(),
      );
      expect(guardianship?.scholarUserId).toBe(school.parents[0].children[0].id);
    }
  });

  test("respects schools/scholarsPerSchool/parentsPerSchool/includePlatformAdmin options", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 3,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });

    expect(world.schools).toHaveLength(1);
    expect(world.schools[0].scholars).toHaveLength(3);
    expect(world.schools[0].parents).toHaveLength(0);
    expect(world.platformAdmin).toBeUndefined();
    await expect(world.as.platformAdmin()).rejects.toThrow(
      /no platform admin/i,
    );
  });

  test("identity accessors resolve to the intended user via a real authedQuery", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const [schoolA, schoolB] = world.schools;

    const asTeacher = await world.as.staffOf(schoolA);
    const asAdmin = await world.as.staffOf(schoolA, "school_admin");
    const asOps = await world.as.staffOf(schoolA, "staff");
    const asScholar = await world.as.scholar(schoolA.scholars[0]);
    const asParent = await world.as.parent(schoolA.parents[0]);
    const asPlatformAdmin = await world.as.platformAdmin();

    const [teacherMe, adminMe, opsMe, scholarMe, parentMe, adminMeGlobal] =
      await Promise.all([
        asTeacher.query(api.users.currentUser, {}),
        asAdmin.query(api.users.currentUser, {}),
        asOps.query(api.users.currentUser, {}),
        asScholar.query(api.users.currentUser, {}),
        asParent.query(api.users.currentUser, {}),
        asPlatformAdmin.query(api.users.currentUser, {}),
      ]);

    expect(teacherMe?._id).toBe(schoolA.teacher.id);
    expect(teacherMe?.username).toBe(schoolA.teacher.username);
    expect(adminMe?._id).toBe(schoolA.admin.id);
    expect(opsMe?._id).toBe(schoolA.ops.id);
    expect(scholarMe?._id).toBe(schoolA.scholars[0].id);
    expect(parentMe?._id).toBe(schoolA.parents[0].id);
    expect(adminMeGlobal?._id).toBe(world.platformAdmin?.id);

    // Cross-school sanity: school B's teacher identity resolves to a
    // DIFFERENT user than school A's, even though both are "the teacher".
    const asOtherTeacher = await world.as.staffOf(schoolB);
    const otherTeacherMe = await asOtherTeacher.query(
      api.users.currentUser,
      {},
    );
    expect(otherTeacherMe?._id).toBe(schoolB.teacher.id);
    expect(otherTeacherMe?._id).not.toBe(teacherMe?._id);
  });

  test("usernames stay unique across repeated builder calls in one file", async () => {
    const t = convexTest(schema, modules);
    const worldA = await makeWorld(t);
    const worldB = await makeWorld(t);
    expect(worldA.schools[0].teacher.username).not.toBe(
      worldB.schools[0].teacher.username,
    );
  });
});

describe("per-entity builders", () => {
  test("makeScholar/makeStaff/makeParent/makePlatformAdmin accept overrides", async () => {
    const t = convexTest(schema, modules);
    const institutionId = (await makeWorld(t, { schools: 1, scholarsPerSchool: 0, parentsPerSchool: 0 }))
      .schools[0].id;

    const scholar = await makeScholar(t, institutionId, {
      name: "Custom Scholar",
      username: "custom-scholar",
      gradeLevel: "5",
    });
    expect(scholar.name).toBe("Custom Scholar");
    expect(scholar.username).toBe("custom-scholar");
    const row = await t.run((ctx) => ctx.db.get(scholar.id));
    expect(row?.gradeLevel).toBe("5");

    const staff = await makeStaff(t, institutionId, "teacher", {
      name: "Custom Teacher",
    });
    expect(staff.role).toBe("teacher");

    const parent = await makeParent(t, [scholar], { name: "Custom Parent" });
    expect(parent.children[0].id).toBe(scholar.id);

    const admin = await makePlatformAdmin(t, { name: "Custom Admin" });
    expect(admin.name).toBe("Custom Admin");
  });

  test("makeSession/makeUnit/makeLesson/makeActivity seed a schema-valid curriculum chain", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, scholarsPerSchool: 1, parentsPerSchool: 0 });
    const school = world.schools[0];

    const sessionId = await makeSession(t, school.scholars[0], {
      title: "Custom Session",
    });
    const sessionRow = await t.run((ctx) => ctx.db.get(sessionId));
    expect(sessionRow?.title).toBe("Custom Session");
    expect(sessionRow?.userId).toBe(school.scholars[0].id);

    const unitId = await makeUnit(t, school.teacher, school, {
      title: "Custom Unit",
    });
    const lessonId = await makeLesson(t, unitId, { title: "Custom Lesson" });
    const activityId = await makeActivity(t, lessonId, {
      title: "Custom Activity",
    });

    const unitRow = await t.run((ctx) => ctx.db.get(unitId));
    const lessonRow = await t.run((ctx) => ctx.db.get(lessonId));
    const activityRow = await t.run((ctx) => ctx.db.get(activityId));
    expect(unitRow?.teacherId).toBe(school.teacher.id);
    expect(unitRow?.institutionId).toBe(school.id);
    expect(lessonRow?.unitId).toBe(unitId);
    expect(activityRow?.lessonId).toBe(lessonId);
  });
});

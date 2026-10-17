/**
 * Unit publication (TRA-490): a new catalog unit is teachers-only until a
 * teacher publishes it or assigns it.
 *
 * The risk is a scholar reaching a unit the teacher has not released — by
 * listing it in Start a Quest or by starting a session on it directly — so
 * every scholar-facing assertion goes through the real public functions.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  makeActivity,
  makeLesson,
  makeUnit,
  makeWorld,
} from "./factories/world";
import { plantBadgeFollowSeed, plantTeacherSeed } from "../lib/seeds";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seed(schools = 1) {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, {
    schools,
    scholarsPerSchool: 2,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const school = world.schools[0];
  const asTeacher = await world.as.staffOf(school);
  const scholar = school.scholars[0];
  const asScholar = await world.as.scholar(scholar);
  return { t, world, school, asTeacher, scholar, asScholar };
}

async function addActivity(
  t: ReturnType<typeof convexTest>,
  unitId: Id<"units">,
) {
  const lessonId = await makeLesson(t, unitId);
  const activityId = await makeActivity(t, lessonId, {
    systemPrompt: "Explore.",
  });
  return { lessonId, activityId };
}

function ids(rows: Array<{ _id: Id<"units"> }>) {
  return rows.map((row) => row._id);
}

describe("unit publication", () => {
  test("a new unit is unpublished: teachers list it, scholars do not", async () => {
    const { t, asTeacher, asScholar } = await seed();
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Draft unit",
    });

    const row = await t.run((ctx) => ctx.db.get(unitId));
    expect(row?.unpublished).toBe(true);
    expect(ids(await asTeacher.query(api.units.list, {}))).toContain(unitId);
    expect(ids(await asScholar.query(api.units.list, {}))).not.toContain(
      unitId,
    );
    expect(
      ids(await asScholar.query(api.units.list, { asLearner: true })),
    ).not.toContain(unitId);
  });

  test("legacy units (field absent) read as published", async () => {
    const { t, school, asScholar } = await seed();
    const legacyId = await makeUnit(t, school.teacher, school, {
      title: "Legacy unit",
    });
    expect(ids(await asScholar.query(api.units.list, {}))).toContain(legacyId);
  });

  test("publish and unpublish flip scholar visibility", async () => {
    const { t, asTeacher, asScholar } = await seed();
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Release me",
    });

    await asTeacher.mutation(api.units.publish, { id: unitId });
    expect((await t.run((ctx) => ctx.db.get(unitId)))?.unpublished).toBe(
      undefined,
    );
    expect(ids(await asScholar.query(api.units.list, {}))).toContain(unitId);

    await asTeacher.mutation(api.units.unpublish, { id: unitId });
    expect(ids(await asScholar.query(api.units.list, {}))).not.toContain(
      unitId,
    );
  });

  test("a scholar cannot publish a unit", async () => {
    const { asTeacher, asScholar } = await seed();
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Not yours",
    });
    await expect(
      asScholar.mutation(api.units.publish, { id: unitId }),
    ).rejects.toThrow();
  });

  test("the aide's publish tool uses the caller's edit gate", async () => {
    const { t, school, asTeacher } = await seed();
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Aide release",
    });
    const res = await t.mutation(internal.units.aideSetUnitPublished, {
      callerUserId: school.teacher.id,
      unitId,
      published: true,
    });
    expect(res.published).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(unitId)))?.unpublished).toBe(
      undefined,
    );
    await expect(
      t.mutation(internal.units.aideSetUnitPublished, {
        callerUserId: school.scholars[0].id,
        unitId,
        published: false,
      }),
    ).rejects.toThrow();
  });

  test("sessions.create refuses a scholar on an unpublished unit", async () => {
    const { t, asTeacher, asScholar } = await seed();
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Not yet",
    });
    const { lessonId, activityId } = await addActivity(t, unitId);

    await expect(
      asScholar.mutation(api.sessions.create, { unitId, lessonId, activityId }),
    ).rejects.toThrow("This unit isn't available yet.");
    await expect(
      asScholar.mutation(api.sessions.startUnit, { unitId }),
    ).rejects.toThrow("This unit isn't available yet.");
  });

  test("a staff rehearsal of an unpublished unit still works", async () => {
    const { t, asTeacher } = await seed();
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Rehearse me",
    });
    const { activityId } = await addActivity(t, unitId);

    const { id } = await asTeacher.mutation(api.sessions.create, {
      activityId,
      isTestDrive: true,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.unitId).toBe(unitId);
  });

  test("a scholar holding an assignment can still start and see an unpublished unit", async () => {
    const { t, world, school, asTeacher, scholar, asScholar } = await seed();
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Assigned then hidden",
    });
    const { lessonId, activityId } = await addActivity(t, unitId);
    // Assigned, then unpublished afterwards: the assignment keeps it open
    // to the scholar it names, and only to them.
    const assignmentId = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: school.teacher.id,
        unitId,
        scholarIds: [scholar.id],
        startedAt: Date.now() - 60_000,
        activitySchedule: [
          {
            activityId,
            mode: "classFocus" as const,
            setAt: Date.now() - 60_000,
            endsAt: Date.now() + 60_000,
          },
        ],
      }),
    );
    expect((await t.run((ctx) => ctx.db.get(unitId)))?.unpublished).toBe(true);

    const withAssignment = await asScholar.mutation(api.sessions.create, {
      unitId,
      lessonId,
      activityId,
      assignmentId,
    });
    expect(withAssignment.id).toBeTruthy();
    expect(ids(await asScholar.query(api.units.list, {}))).toContain(unitId);

    const asOther = await world.as.scholar(school.scholars[1]);
    expect(ids(await asOther.query(api.units.list, {}))).not.toContain(unitId);
    await expect(
      asOther.mutation(api.sessions.create, { unitId, lessonId, activityId }),
    ).rejects.toThrow("This unit isn't available yet.");
  });

  test("assigning an unpublished unit publishes it", async () => {
    const { t, asTeacher, scholar, asScholar } = await seed();
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Assign me",
    });
    await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholar.id],
    });
    expect((await t.run((ctx) => ctx.db.get(unitId)))?.unpublished).toBe(
      undefined,
    );
    expect(ids(await asScholar.query(api.units.list, {}))).toContain(unitId);
  });

  test("a duplicate of a published unit starts unpublished", async () => {
    const { t, school, asTeacher, asScholar } = await seed();
    const sourceId = await makeUnit(t, school.teacher, school, {
      title: "Published source",
    });
    const copyId = await asTeacher.mutation(api.units.duplicate, {
      unitId: sourceId,
    });
    expect((await t.run((ctx) => ctx.db.get(copyId)))?.unpublished).toBe(true);
    const scholarUnits = ids(await asScholar.query(api.units.list, {}));
    expect(scholarUnits).toContain(sourceId);
    expect(scholarUnits).not.toContain(copyId);
  });

  test("the curriculum browser marks unpublished rows", async () => {
    const { t, school, asTeacher } = await seed();
    const legacyId = await makeUnit(t, school.teacher, school, {
      title: "Legacy",
    });
    const draftId = await asTeacher.mutation(api.units.create, {
      title: "Draft",
    });
    const page = await asTeacher.query(api.units.listForBrowser, {
      showArchived: false,
      paginationOpts: { numItems: 20, cursor: null },
    });
    const byId = new Map(page.page.map((row) => [row._id, row.unpublished]));
    expect(byId.get(draftId)).toBe(true);
    expect(byId.get(legacyId)).toBe(false);
  });

  test("a badge trail cannot lead a scholar into an unpublished unit; a teacher offer can", async () => {
    const { t, world, school, asTeacher, scholar, asScholar } = await seed();
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Pod-mate's quest",
    });
    await addActivity(t, unitId);
    const trailSeedId = await t.run(async (ctx) =>
      (
        await plantBadgeFollowSeed(ctx, {
          scholarId: scholar.id,
          topic: "Pod-mate's quest",
          inspiredByName: "A pod-mate",
          rationale: "Follow the trail",
          unitId,
        })
      ).id,
    );
    await expect(
      asScholar.mutation(api.sessions.createFromSeed, { seedId: trailSeedId }),
    ).rejects.toThrow("This unit isn't available yet.");

    // The offer goes to a classmate: plantTeacherSeed dedupes on the unit, so
    // offering it to the same scholar would return the trail star.
    const classmate = school.scholars[1];
    const offerSeedId = await t.run(async (ctx) =>
      (
        await plantTeacherSeed(ctx, {
          scholarId: classmate.id,
          topic: "Offered quest",
          rationale: "Your teacher set this up",
          teacherId: school.teacher.id,
          unitId,
        })
      ).id,
    );
    const asClassmate = await world.as.scholar(classmate);
    const { id } = await asClassmate.mutation(api.sessions.createFromSeed, {
      seedId: offerSeedId,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.unitId).toBe(unitId);

    // Once published, the trail opens too.
    await asTeacher.mutation(api.units.publish, { id: unitId });
    const viaTrail = await asScholar.mutation(api.sessions.createFromSeed, {
      seedId: trailSeedId,
    });
    expect(viaTrail.id).toBeTruthy();
  });

  test("the aide's create_unit writes an unpublished unit and its reads report the state", async () => {
    const { t, school } = await seed();
    const { unitId } = await t.mutation(
      internal.teacherAide.createCurriculumUnit,
      { authorId: school.teacher.id, title: "Aide-built unit" },
    );
    expect((await t.run((ctx) => ctx.db.get(unitId)))?.unpublished).toBe(true);

    const listed = await t.query(
      internal.curriculumAssistant.listUnitsInternal,
      { callerUserId: school.teacher.id },
    );
    expect(listed.find((u) => u.id === unitId)?.unpublished).toBe(true);
    const details = await t.query(
      internal.curriculumAssistant.getUnitDetails,
      { unitId },
    );
    expect(details?.unpublished).toBe(true);
  });

  test("assigning through coreAssignWork (the aide's assign_unit) publishes", async () => {
    const { t, school, scholar, asScholar } = await seed();
    const { unitId } = await t.mutation(
      internal.teacherAide.createCurriculumUnit,
      { authorId: school.teacher.id, title: "Assigned by the aide" },
    );
    await t.mutation(internal.assignments.aideAssignWork, {
      callerUserId: school.teacher.id,
      unitId,
      scholarIds: [scholar.id],
      startsAt: Date.now(),
      target: { kind: "unit" },
    });
    expect((await t.run((ctx) => ctx.db.get(unitId)))?.unpublished).toBe(
      undefined,
    );
    expect(ids(await asScholar.query(api.units.list, {}))).toContain(unitId);
  });

  test("assigning another school's unit does not publish it", async () => {
    const { t, world } = await seed(2);
    const [home, foreign] = world.schools;
    const asHomeTeacher = await world.as.staffOf(home);
    const unitId = await asHomeTeacher.mutation(api.units.create, {
      title: "Home draft",
    });
    // A foreign teacher naming the home unit for their own scholars. Whether
    // the assignment itself is refused is the pre-existing tenancy question;
    // publication must not change either way.
    await t
      .mutation(internal.assignments.aideAssignWork, {
        callerUserId: foreign.teacher.id,
        unitId,
        scholarIds: [foreign.scholars[0].id],
        startsAt: Date.now(),
        target: { kind: "unit" },
      })
      .catch(() => undefined);
    const asForeignTeacher = await world.as.staffOf(foreign);
    await asForeignTeacher
      .mutation(api.assignments.create, {
        unitId,
        scholarIds: [foreign.scholars[0].id],
      })
      .catch(() => undefined);
    expect((await t.run((ctx) => ctx.db.get(unitId)))?.unpublished).toBe(true);
  });

  test("a program guest sees and starts an unpublished unit only through its program assignment", async () => {
    const { t, school, asTeacher, scholar, asScholar } = await seed();
    await t.run((ctx) =>
      ctx.db.patch(scholar.id, { enrollmentStanding: "program_guest" }),
    );
    const assignedId = await asTeacher.mutation(api.units.create, {
      title: "Program draft",
    });
    const { activityId } = await addActivity(t, assignedId);
    const otherId = await asTeacher.mutation(api.units.create, {
      title: "Unassigned draft",
    });
    await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId: school.teacher.id,
        institutionId: school.id,
        name: "Robotics",
        participation: "includes_program_guests",
        scholarIds: [scholar.id],
      });
      await ctx.db.insert("assignments", {
        teacherId: school.teacher.id,
        unitId: assignedId,
        scholarGroupId: groupId,
        scholarIds: [scholar.id],
        startedAt: Date.now(),
        selfPaced: true,
        activitySchedule: [
          { activityId, mode: "homework", setAt: Date.now() },
        ],
      });
    });
    const listed = ids(await asScholar.query(api.units.list, {}));
    expect(listed).toContain(assignedId);
    expect(listed).not.toContain(otherId);
    const { id } = await asScholar.mutation(api.sessions.startUnit, {
      unitId: assignedId,
    });
    expect(id).toBeTruthy();
  });

  test("units.subjects hides an unpublished unit's subject from scholars", async () => {
    const { t, school, asTeacher, asScholar } = await seed();
    await asTeacher.mutation(api.units.create, {
      title: "Draft in a new subject",
      subject: "Astronomy",
    });
    await makeUnit(t, school.teacher, school, {
      title: "Published",
      subject: "Botany",
    });
    const scholarSubjects = await asScholar.query(api.units.subjects, {});
    expect(scholarSubjects).toContain("Botany");
    expect(scholarSubjects).not.toContain("Astronomy");
    expect(await asTeacher.query(api.units.subjects, {})).toContain(
      "Astronomy",
    );
  });
});

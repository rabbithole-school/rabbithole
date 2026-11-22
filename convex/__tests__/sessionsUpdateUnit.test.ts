import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { makeSession, makeUnit, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// TRA-674: sessions.update let a caller point a session at any unit id, and
// the unit's prompt and design then load into that session's tutor. A unit is
// now accepted only when the caller and the session's learner can read it.
describe("sessions.update unit scope", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [school, otherSchool] = world.schools;
    const [scholar, podMate] = school.scholars;
    const sessionId = await makeSession(t, scholar);
    const otherSchoolUnit = await makeUnit(t, otherSchool.teacher, otherSchool, {
      title: "Another school's unit",
    });
    // A pod-mate's own Quest at the same school.
    const podMateQuest = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: podMate.id,
        institutionId: school.id,
        title: "Pod-mate's Quest",
        isActive: true,
        authorScholarId: podMate.id,
        authorRole: "author",
      }),
    );
    const ownQuest = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: scholar.id,
        institutionId: school.id,
        title: "My Quest",
        isActive: true,
        authorScholarId: scholar.id,
        authorRole: "author",
      }),
    );
    // A school unit the teacher assigned to this scholar.
    const assignedUnit = await makeUnit(t, school.teacher, school, {
      title: "Assigned unit",
      unpublished: true,
    });
    await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: school.teacher.id,
        scholarIds: [scholar.id],
        unitId: assignedUnit,
        startedAt: Date.now(),
      }),
    );
    return {
      t,
      sessionId,
      units: { otherSchoolUnit, podMateQuest, ownQuest, assignedUnit },
      asScholar: await world.as.scholar(scholar),
      asTeacher: await world.as.staffOf(school),
    };
  }

  test("a scholar cannot point their session at another school's unit or a pod-mate's Quest", async () => {
    const { t, sessionId, units, asScholar } = await setup();
    for (const unitId of [units.otherSchoolUnit, units.podMateQuest]) {
      await expect(
        asScholar.mutation(api.sessions.update, { id: sessionId, unitId }),
      ).rejects.toThrow(/Forbidden/);
    }
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.unitId).toBeUndefined();
  });

  test("a scholar can still set their own Quest or an assigned unit, and clear it", async () => {
    const { sessionId, units, asScholar } = await setup();
    for (const unitId of [units.ownQuest, units.assignedUnit]) {
      const row = await asScholar.mutation(api.sessions.update, {
        id: sessionId,
        unitId,
      });
      expect(row?.unitId).toBe(unitId);
    }
    const cleared = await asScholar.mutation(api.sessions.update, {
      id: sessionId,
      unitId: null,
    });
    expect(cleared?.unitId).toBeUndefined();
  });

  test("a teacher sets a school unit as before, but not another school's", async () => {
    const { sessionId, units, asTeacher } = await setup();
    const row = await asTeacher.mutation(api.sessions.update, {
      id: sessionId,
      unitId: units.assignedUnit,
    });
    expect(row?.unitId).toBe(units.assignedUnit);
    await expect(
      asTeacher.mutation(api.sessions.update, {
        id: sessionId,
        unitId: units.otherSchoolUnit,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

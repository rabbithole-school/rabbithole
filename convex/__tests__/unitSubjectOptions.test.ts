import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { classSubjectKey } from "../lib/classResolver";
import {
  resolveUnitSubject,
  unitSubjectNotAClass,
  unitSubjectNotAClassDetails,
} from "../lib/unitSubject";
import { makeUnit, makeWorld, type WorldSchool } from "./factories/world";
import { grantInstitutionMembership } from "./institutionTestHelpers";

// TRA-723: a unit's subject is one of the school's classes. The options are
// the class names on the school's timetable this term; the aide's writes must
// pick one (mapping a clear near miss, asking again otherwise).

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const NOW = Date.parse("2026-11-10T08:00:00-10:00");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

type T = ReturnType<typeof convexTest>;

/** A term covering NOW and two groups at `school`; returns a helper that
 *  puts a class on the timetable. */
async function timetable(t: T, school: WorldSchool) {
  return await t.run(async (ctx) => {
    const periodId = await ctx.db.insert("reportingPeriods", {
      institutionId: school.id,
      label: "Fall",
      startsAt: NOW - 60 * 86_400_000,
      endsAt: NOW + 60 * 86_400_000,
      status: "open",
    });
    const groupIds: Id<"scholarGroups">[] = [];
    for (const name of ["Honu", "Nai'a"]) {
      groupIds.push(
        await ctx.db.insert("scholarGroups", {
          institutionId: school.id,
          teacherId: school.teacher.id,
          name,
          scholarIds: school.scholars.map((s) => s.id),
        }),
      );
    }
    return { periodId, groupIds };
  });
}

async function addClass(
  t: T,
  school: WorldSchool,
  periodId: Id<"reportingPeriods">,
  groupId: Id<"scholarGroups">,
  subject: string,
  archived = false,
) {
  await t.run((ctx) =>
    ctx.db.insert("classes", {
      institutionId: school.id,
      periodId,
      groupId,
      subject,
      subjectKey: classSubjectKey(subject),
      meetings: [],
      ...(archived ? { archivedAt: NOW - 1000 } : {}),
    }),
  );
}

/** Two groups at `school` and no term. */
async function terms(t: T, school: WorldSchool) {
  const groupIds: Id<"scholarGroups">[] = [];
  for (const name of ["Honu", "Nai'a"]) {
    groupIds.push(
      await t.run((ctx) =>
        ctx.db.insert("scholarGroups", {
          institutionId: school.id,
          teacherId: school.teacher.id,
          name,
          scholarIds: school.scholars.map((s) => s.id),
        }),
      ),
    );
  }
  return { groupIds };
}

async function addTerm(t: T, school: WorldSchool, startsAt: number, endsAt: number) {
  return await t.run((ctx) =>
    ctx.db.insert("reportingPeriods", {
      institutionId: school.id,
      label: "Term",
      startsAt,
      endsAt,
      status: "open",
    }),
  );
}

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { schools: 2, parentsPerSchool: 1 });
  const [school, other] = world.schools;
  const teacher = await world.as.staffOf(school);
  return { t, world, school, other, teacher };
}

describe("subjectOptions (the unit's school's class names)", () => {
  test("one option per class name across groups; archived and other schools' classes excluded", async () => {
    const { t, school, other, teacher } = await setup();
    const { periodId, groupIds } = await timetable(t, school);
    await addClass(t, school, periodId, groupIds[0], "Humanities");
    await addClass(t, school, periodId, groupIds[1], "Humanities ");
    await addClass(t, school, periodId, groupIds[0], "Math");
    await addClass(t, school, periodId, groupIds[1], "Robotics", true);
    const theirs = await timetable(t, other);
    await addClass(t, other, theirs.periodId, theirs.groupIds[0], "Marine Biology");
    const unitId = await makeUnit(t, school.teacher, school);

    expect(await teacher.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([
      "Humanities",
      "Math",
    ]);
  });

  test("a platform admin and a two-school staff member see the unit's school's classes", async () => {
    const { t, world, school, other } = await setup();
    const { periodId, groupIds } = await timetable(t, school);
    await addClass(t, school, periodId, groupIds[0], "Humanities");
    const theirs = await timetable(t, other);
    await addClass(t, other, theirs.periodId, theirs.groupIds[0], "Marine Biology");
    // The unit belongs to the second (non-primary) school.
    const unitId = await makeUnit(t, other.teacher, other);

    const admin = await world.as.platformAdmin();
    expect(await admin.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([
      "Marine Biology",
    ]);

    // The primary school's teacher also teaches at the second school: their
    // home school's classes must not show up in this unit's picker.
    await grantInstitutionMembership(t, school.teacher.id, other.id, "teacher");
    const twoSchool = await world.as.staffOf(school);
    expect(await twoSchool.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([
      "Marine Biology",
    ]);
  });

  test("a caller who may not edit the unit gets nothing", async () => {
    const { t, world, school, other } = await setup();
    const { periodId, groupIds } = await timetable(t, school);
    await addClass(t, school, periodId, groupIds[0], "Humanities");
    const unitId = await makeUnit(t, school.teacher, school);
    const outsider = await world.as.staffOf(other);
    expect(await outsider.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([]);
    const scholar = await world.as.scholar(school.scholars[0]);
    expect(await scholar.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([]);
  });

  test("between terms, the most recent past term's classes", async () => {
    const { t, school, teacher } = await setup();
    const w = await terms(t, school);
    const spring = await addTerm(t, school, NOW - 200 * 86_400_000, NOW - 20 * 86_400_000);
    const older = await addTerm(t, school, NOW - 400 * 86_400_000, NOW - 250 * 86_400_000);
    const fall = await addTerm(t, school, NOW + 20 * 86_400_000, NOW + 200 * 86_400_000);
    await addClass(t, school, spring, w.groupIds[0], "Humanities");
    await addClass(t, school, older, w.groupIds[0], "Latin");
    await addClass(t, school, fall, w.groupIds[0], "Science");
    const unitId = await makeUnit(t, school.teacher, school);
    expect(await teacher.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([
      "Humanities",
    ]);
  });

  test("a new term with no classes yet falls back to the last term's classes", async () => {
    const { t, school, teacher } = await setup();
    const w = await terms(t, school);
    await addTerm(t, school, NOW - 10 * 86_400_000, NOW + 100 * 86_400_000); // covers now, empty
    const last = await addTerm(t, school, NOW - 200 * 86_400_000, NOW - 10 * 86_400_000);
    await addClass(t, school, last, w.groupIds[0], "Math");
    const unitId = await makeUnit(t, school.teacher, school);
    expect(await teacher.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([
      "Math",
    ]);
  });

  test("before any term with classes, the next upcoming one", async () => {
    const { t, school, teacher } = await setup();
    const w = await terms(t, school);
    const next = await addTerm(t, school, NOW + 10 * 86_400_000, NOW + 100 * 86_400_000);
    const later = await addTerm(t, school, NOW + 120 * 86_400_000, NOW + 200 * 86_400_000);
    await addClass(t, school, next, w.groupIds[0], "Robotics");
    await addClass(t, school, later, w.groupIds[0], "Art");
    const unitId = await makeUnit(t, school.teacher, school);
    expect(await teacher.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([
      "Robotics",
    ]);
  });

  test("overlapping terms both covering now: every covering term's classes", async () => {
    const { t, school, teacher } = await setup();
    const w = await terms(t, school);
    const semester = await addTerm(t, school, NOW - 50 * 86_400_000, NOW + 50 * 86_400_000);
    const quarter = await addTerm(t, school, NOW - 10 * 86_400_000, NOW + 30 * 86_400_000);
    await addClass(t, school, semester, w.groupIds[0], "Humanities");
    await addClass(t, school, quarter, w.groupIds[1], "Math");
    const unitId = await makeUnit(t, school.teacher, school);
    expect(await teacher.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([
      "Humanities",
      "Math",
    ]);
  });

  test("a school with no timetable has no options", async () => {
    const { t, school, teacher } = await setup();
    const unitId = await makeUnit(t, school.teacher, school);
    expect(await teacher.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([]);
  });
});

describe("resolveUnitSubject", () => {
  const options = ["Humanities", "Math", "Science"];
  test("an exact class name, any case, is accepted as the class's spelling", () => {
    expect(resolveUnitSubject("math", options)).toEqual({
      kind: "ok",
      subject: "Math",
      mapped: false,
    });
  });
  test("a subject that fits exactly one class is filed under it", () => {
    expect(resolveUnitSubject("Social Studies", options)).toEqual({
      kind: "ok",
      subject: "Humanities",
      mapped: true,
    });
  });
  test("an unknown or ambiguous subject asks again with the options", () => {
    expect(resolveUnitSubject("Robotics", options)).toEqual({
      kind: "ask",
      given: "Robotics",
      options,
    });
    expect(resolveUnitSubject("Science & Math", options)).toMatchObject({ kind: "ask" });
  });
  test("with no classes the old rule stands", () => {
    expect(resolveUnitSubject("Robotics Extended Ed", [])).toEqual({
      kind: "ok",
      subject: "Robotics Extended Ed",
      mapped: false,
    });
    expect(resolveUnitSubject("tbd", [])).toEqual({ kind: "missing" });
  });
});

describe("the aide's unit writes", () => {
  async function withClasses() {
    const w = await setup();
    const { periodId, groupIds } = await timetable(w.t, w.school);
    await addClass(w.t, w.school, periodId, groupIds[0], "Humanities");
    await addClass(w.t, w.school, periodId, groupIds[0], "Math");
    return w;
  }
  const create = (t: T, authorId: Id<"users">, title: string, subject: string) =>
    t.mutation(internal.teacherAide.createCurriculumUnit, {
      authorId,
      title,
      subject,
      requireSubjectForNew: true,
    });
  const units = (t: T) => t.run((ctx) => ctx.db.query("units").collect());

  test("create_unit: an exact option is written as the class's spelling", async () => {
    const { t, school } = await withClasses();
    const result = await create(t, school.teacher.id, "Fractions", "MATH");
    expect(result.filedUnder).toBeUndefined();
    const unit = await t.run((ctx) => ctx.db.get(result.unitId));
    expect(unit?.subject).toBe("Math");
  });

  test("create_unit: Social Studies is filed under Humanities, and says so", async () => {
    const { t, school } = await withClasses();
    const result = await create(t, school.teacher.id, "Voyaging", "Social Studies");
    expect(result.filedUnder).toBe("Humanities");
    const unit = await t.run((ctx) => ctx.db.get(result.unitId));
    expect(unit?.subject).toBe("Humanities");
  });

  test("create_unit: an unknown subject gets the options back and writes nothing", async () => {
    const { t, school } = await withClasses();
    const before = (await units(t)).length;
    let caught: unknown;
    try {
      await create(t, school.teacher.id, "Gears", "Robotics");
    } catch (error) {
      caught = error;
    }
    expect(unitSubjectNotAClassDetails(caught)).toEqual({
      given: "Robotics",
      options: ["Humanities", "Math"],
    });
    expect((await units(t)).length).toBe(before);
  });

  test("create_unit: a school without classes keeps the old rule", async () => {
    const { t, school } = await setup();
    const result = await create(t, school.teacher.id, "Gears", "Robotics Extended Ed");
    const unit = await t.run((ctx) => ctx.db.get(result.unitId));
    expect(unit?.subject).toBe("Robotics Extended Ed");
  });

  test("update_unit: maps a near miss, refuses an unknown subject without writing", async () => {
    const { t, school } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "Math" });
    const mapped = await t.mutation(internal.curriculumAssistant.updateUnitInternal, {
      unitId,
      subject: "History",
      bigIdea: "People move",
    });
    expect(mapped).toEqual({
      kind: "updated",
      filedUnder: "Humanities",
      updatedFields: ["bigIdea", "subject"],
    });
    expect((await t.run((ctx) => ctx.db.get(unitId)))?.subject).toBe("Humanities");

    const refused = await t.mutation(internal.curriculumAssistant.updateUnitInternal, {
      unitId,
      subject: "Robotics",
      bigIdea: "Changed",
    });
    expect(refused).toEqual({
      kind: "subject_not_a_class",
      given: "Robotics",
      options: ["Humanities", "Math"],
    });
    const after = await t.run((ctx) => ctx.db.get(unitId));
    expect(after?.subject).toBe("Humanities");
    expect(after?.bigIdea).toBe("People move");
  });

  test("create_unit between terms still files under the last term's class", async () => {
    const { t, school } = await setup();
    const w = await terms(t, school);
    const spring = await addTerm(t, school, NOW - 200 * 86_400_000, NOW - 20 * 86_400_000);
    await addClass(t, school, spring, w.groupIds[0], "Humanities");
    const result = await create(t, school.teacher.id, "Voyaging", "Social Studies");
    expect(result.filedUnder).toBe("Humanities");
    let caught: unknown;
    try {
      await create(t, school.teacher.id, "Gears", "Robotics");
    } catch (error) {
      caught = error;
    }
    expect(unitSubjectNotAClassDetails(caught)?.options).toEqual(["Humanities"]);
  });

  test("create_unit: a placeholder at a school with classes gets the class list", async () => {
    const { t, school } = await withClasses();
    let caught: unknown;
    try {
      await create(t, school.teacher.id, "Odds and ends", "general");
    } catch (error) {
      caught = error;
    }
    expect(unitSubjectNotAClassDetails(caught)?.options).toEqual(["Humanities", "Math"]);
    expect((await units(t)).length).toBe(0);
  });

  test("update_unit: a placeholder at a school with classes is refused, nothing written", async () => {
    const { t, school } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "Math" });
    const result = await t.mutation(internal.curriculumAssistant.updateUnitInternal, {
      unitId,
      subject: "general",
      bigIdea: "Changed",
    });
    expect(result).toMatchObject({ kind: "subject_not_a_class", options: ["Humanities", "Math"] });
    const unit = await t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.subject).toBe("Math");
    expect(unit?.bigIdea).toBeUndefined();
  });

  test("update_unit: echoing an off-list current subject keeps it and saves the other edits", async () => {
    const { t, school } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "Robotics Extended Ed" });
    const result = await t.mutation(internal.curriculumAssistant.updateUnitInternal, {
      unitId,
      subject: " robotics extended ed ",
      bigIdea: "Machines extend us",
    });
    // The echoed subject is left as it is, so only the Big Idea is written.
    expect(result).toEqual({ kind: "updated", updatedFields: ["bigIdea"] });
    const unit = await t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.subject).toBe("Robotics Extended Ed");
    expect(unit?.bigIdea).toBe("Machines extend us");
  });

  test("update_unit: a re-send in another case is kept, not re-filed by meaning", async () => {
    const { t, school } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "Social Studies" });
    const result = await t.mutation(internal.curriculumAssistant.updateUnitInternal, {
      unitId,
      subject: "social studies",
      bigIdea: "People move",
    });
    expect(result).toEqual({ kind: "updated", updatedFields: ["bigIdea"] });
    const unit = await t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.subject).toBe("Social Studies");
    expect(unit?.bigIdea).toBe("People move");
  });

  test("the refusal says nothing else in the call was saved", () => {
    expect(unitSubjectNotAClass("update_unit", "Robotics", ["Math"])).toContain(
      "Nothing in this call was saved (no other field either)",
    );
  });

  test("a scholar's own unit keeps free text: no options, no class required", async () => {
    const { t, school, teacher } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "Math" });
    await t.run((ctx) => ctx.db.patch(unitId, { authorScholarId: school.scholars[0].id }));
    expect(await teacher.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([]);
    const result = await t.mutation(internal.curriculumAssistant.updateUnitInternal, {
      unitId,
      subject: "Dinosaurs",
    });
    expect(result).toEqual({ kind: "updated", updatedFields: ["subject"] });
    expect((await t.run((ctx) => ctx.db.get(unitId)))?.subject).toBe("Dinosaurs");
  });

  test("a parent gets no options", async () => {
    const { t, world, school } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school);
    const parent = await world.as.parent(school.parents[0]);
    expect(await parent.query(api.units.subjectOptions, { unitId, at: NOW })).toEqual([]);
  });
});

describe("the web unit writes (units.update, units.duplicate)", () => {
  async function withClasses() {
    const w = await setup();
    const { periodId, groupIds } = await timetable(w.t, w.school);
    await addClass(w.t, w.school, periodId, groupIds[0], "Humanities");
    await addClass(w.t, w.school, periodId, groupIds[0], "Math");
    return w;
  }
  const unitOf = (t: T, id: Id<"units">) => t.run((ctx) => ctx.db.get(id));

  test("update: a class name or a clear fit is written as the class's spelling", async () => {
    const { t, school, teacher } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school);
    await teacher.mutation(api.units.update, { id: unitId, subject: "math" });
    expect((await unitOf(t, unitId))?.subject).toBe("Math");
    await teacher.mutation(api.units.update, { id: unitId, subject: "Social Studies" });
    expect((await unitOf(t, unitId))?.subject).toBe("Humanities");
  });

  test("update: a subject that is not a class is refused and nothing is written", async () => {
    const { t, school, teacher } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "Math" });
    let caught: unknown;
    try {
      await teacher.mutation(api.units.update, {
        id: unitId,
        subject: "Robotics Extended Ed",
        bigIdea: "Changed",
      });
    } catch (error) {
      caught = error;
    }
    expect(unitSubjectNotAClassDetails(caught)).toEqual({
      given: "Robotics Extended Ed",
      options: ["Humanities", "Math"],
    });
    const unit = await unitOf(t, unitId);
    expect(unit?.subject).toBe("Math");
    expect(unit?.bigIdea).toBeUndefined();
  });

  test("update: re-sending an old off-list subject keeps it and saves the other fields", async () => {
    const { t, school, teacher } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "AI Literacy" });
    await teacher.mutation(api.units.update, {
      id: unitId,
      subject: "AI Literacy",
      bigIdea: "Machines persuade",
    });
    const unit = await unitOf(t, unitId);
    expect(unit?.subject).toBe("AI Literacy");
    expect(unit?.bigIdea).toBe("Machines persuade");
  });

  test("update: a re-send differing in case or spacing keeps an off-list subject", async () => {
    const { t, school, teacher } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "AI Literacy" });
    await teacher.mutation(api.units.update, { id: unitId, subject: "ai  literacy" });
    expect((await unitOf(t, unitId))?.subject).toBe("AI Literacy");
  });

  test("update: a re-send is never re-filed by meaning; a case fix takes the class's spelling", async () => {
    const { t, school, teacher } = await withClasses();
    const legacy = await makeUnit(t, school.teacher, school, { subject: "Social Studies" });
    await teacher.mutation(api.units.update, { id: legacy, subject: "social studies" });
    expect((await unitOf(t, legacy))?.subject).toBe("Social Studies");
    const lower = await makeUnit(t, school.teacher, school, { subject: "math" });
    await teacher.mutation(api.units.update, { id: lower, subject: "Math" });
    expect((await unitOf(t, lower))?.subject).toBe("Math");
  });

  test("update: a scholar's own unit keeps free text", async () => {
    const { t, school, teacher } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "Math" });
    await t.run((ctx) => ctx.db.patch(unitId, { authorScholarId: school.scholars[0].id }));
    await teacher.mutation(api.units.update, { id: unitId, subject: "Dinosaurs" });
    expect((await unitOf(t, unitId))?.subject).toBe("Dinosaurs");
  });

  test("create: a subject is filed under its class or refused", async () => {
    const { t, teacher } = await withClasses();
    const mapped = await teacher.mutation(api.units.create, {
      title: "Voyaging",
      subject: "Social Studies",
    });
    expect((await unitOf(t, mapped))?.subject).toBe("Humanities");
    let caught: unknown;
    try {
      await teacher.mutation(api.units.create, { title: "Gears", subject: "Robotics" });
    } catch (error) {
      caught = error;
    }
    expect(unitSubjectNotAClassDetails(caught)?.given).toBe("Robotics");
  });

  test("update: clearing the subject is allowed", async () => {
    const { t, school, teacher } = await withClasses();
    const unitId = await makeUnit(t, school.teacher, school, { subject: "Math" });
    await teacher.mutation(api.units.update, { id: unitId, subject: null });
    expect((await unitOf(t, unitId))?.subject).toBeUndefined();
  });

  test("update: a school without classes keeps free text", async () => {
    const { t, school, teacher } = await setup();
    const unitId = await makeUnit(t, school.teacher, school);
    await teacher.mutation(api.units.update, { id: unitId, subject: "Robotics Extended Ed" });
    expect((await unitOf(t, unitId))?.subject).toBe("Robotics Extended Ed");
  });

  test("duplicate: the copy takes the class its subject fits, else the subject as it is", async () => {
    const { t, school, teacher } = await withClasses();
    const fits = await makeUnit(t, school.teacher, school, { subject: "Mathematics" });
    const noClass = await makeUnit(t, school.teacher, school, { subject: "AI Literacy" });
    const fitsCopy = await teacher.mutation(api.units.duplicate, { unitId: fits });
    const noClassCopy = await teacher.mutation(api.units.duplicate, { unitId: noClass });
    expect((await unitOf(t, fitsCopy))?.subject).toBe("Math");
    expect((await unitOf(t, noClassCopy))?.subject).toBe("AI Literacy");
    // The source is left alone.
    expect((await unitOf(t, fits))?.subject).toBe("Mathematics");
  });
});

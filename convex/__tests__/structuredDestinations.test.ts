import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import {
  makeActivity,
  makeLesson,
  makeUnit,
  makeWorld,
} from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("structured destinations (offer stars)", () => {
  test("opting into a structured star starts the unit's first online activity", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const scholar = school.scholars[0];
    const unit = await makeUnit(t, school.teacher, school, {
      title: "Volcanoes",
      isActive: true,
    });
    const lesson = await makeLesson(t, unit, {
      title: "L1",
      order: 0,
    });
    const activity = await makeActivity(t, lesson, {
      title: "Kickoff",
      order: 0,
      kind: "online",
    });
    const seed = await t.run((ctx) =>
      ctx.db.insert("seeds", {
        scholarId: scholar.id,
        origin: "teacher",
        status: "active",
        topic: "Volcanoes",
        suggestionType: "teacher_suggestion",
        rationale: "offered",
        unitId: unit,
      }),
    );

    const asScholar = await world.as.scholar(scholar);
    const { id } = await asScholar.mutation(api.sessions.createFromSeed, {
      seedId: seed,
    });

    const session = await t.run(async (ctx) => ctx.db.get(id));
    expect(String(session?.unitId)).toBe(String(unit));
    expect(String(session?.activityId)).toBe(String(activity));
    expect(session?.title).toBe("Volcanoes");
  });

  test("opting into a bare proto-activity star stays anchorless", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const scholar = world.schools[0].scholars[0];
    const seed = await t.run((ctx) =>
      ctx.db.insert("seeds", {
        scholarId: scholar.id,
        origin: "ai",
        status: "active",
        topic: "Why is the sky blue?",
        suggestionType: "frontier",
        rationale: "curious",
      }),
    );

    const asScholar = await world.as.scholar(scholar);
    const { id } = await asScholar.mutation(api.sessions.createFromSeed, {
      seedId: seed,
    });
    const session = await t.run(async (ctx) => ctx.db.get(id));
    expect(session?.unitId).toBeUndefined();
    expect(session?.activityId).toBeUndefined();
    expect(session?.title).toBe("Why is the sky blue?");
  });

  test("teacher offer drops a star and is not double-surfaced as a card", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const asTeacher = await world.as.staffOf(school);
    const { unitId } = await asTeacher.mutation(
      api.units.createAndOfferQuestForScholar,
      { scholarId: school.scholars[0].id, title: "Comics" },
    );

    // An offer star now points at that unit on the scholar's sky.
    const asScholar = await world.as.scholar(school.scholars[0]);
    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    const star = sky.seeds.find((s) => s.topic === "Comics");
    expect(star).toBeDefined();
    expect(star?.structured).toBe(true);

    // …and it is NOT also listed as a not-started IS-unit card.
    const cards = await asScholar.query(api.units.myIndependentStudyUnits, {});
    expect(cards.some((u) => String(u.unitId) === String(unitId))).toBe(false);
  });

  test("a scholar's own (un-offered) IS unit still shows as a card", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const asScholar = await world.as.scholar(world.schools[0].scholars[0]);
    const { unitId } = await asScholar.mutation(
      api.units.createQuest,
      { title: "My Own Quest" },
    );
    const cards = await asScholar.query(api.units.myIndependentStudyUnits, {});
    expect(cards.some((u) => String(u.unitId) === String(unitId))).toBe(true);
  });
});

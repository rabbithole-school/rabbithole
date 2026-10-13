// TRA-513: the writing-derived grade estimate is information under the Write
// row. It must never become the talk level, and what it stores must be
// validated and drawn from enough typed words.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { MIN_TYPED_WORDS_FOR_ESTIMATE } from "../lib/readingLevels";
import * as scholarsModule from "../scholars";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seed() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, {
    schools: 1,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const school = world.schools[0];
  const scholarId = school.scholars[0].id;
  await t.run((ctx) => ctx.db.patch(scholarId, { readingLevel: "3" }));
  const asTeacher = await world.as.staffOf(school);
  return { t, school, scholarId, asTeacher };
}

const ENOUGH = MIN_TYPED_WORDS_FOR_ESTIMATE;

describe("the writing estimate is info-only", () => {
  test("no function promotes an estimate into the talk level", () => {
    expect("acceptReadingLevelSuggestion" in scholarsModule).toBe(false);
  });

  test("the teacher-run write stores a canonical grade and its sample, and leaves talk alone", async () => {
    const { t, scholarId, asTeacher } = await seed();

    const outcome = await asTeacher.mutation(
      api.scholars.setReadingLevelSuggestionFromAnalysis,
      { scholarId, suggestion: "Grade 7.0", typedWords: 240 },
    );
    expect(outcome).toBe("stored");

    const scholar = await t.run((ctx) => ctx.db.get(scholarId));
    expect(scholar).toMatchObject({
      readingLevel: "3", // untouched
      readingLevelSuggestion: "7", // "Grade 7.0" and "7" are the same grade
      readingLevelSuggestionWords: 240,
    });
    // Not a ratified change, so nothing in the level history.
    expect(await t.run((ctx) => ctx.db.query("readingLevelHistory").collect())).toHaveLength(0);
  });

  test("an estimate that AGREES with the talk level is stored too, not cleared", async () => {
    const { t, scholarId, asTeacher } = await seed();
    await asTeacher.mutation(api.scholars.setReadingLevelSuggestionFromAnalysis, {
      scholarId,
      suggestion: "3.0",
      typedWords: ENOUGH,
    });
    const scholar = await t.run((ctx) => ctx.db.get(scholarId));
    expect(scholar?.readingLevelSuggestion).toBe("3");
  });

  test("the observer path refuses a sample under the typed-word floor", async () => {
    const { t, scholarId } = await seed();
    const outcome = await t.mutation(internal.scholars.setReadingLevelSuggestion, {
      scholarId,
      suggestion: "9",
      typedWords: ENOUGH - 1,
    });
    expect(outcome).toBe("too_few_words");
    const scholar = await t.run((ctx) => ctx.db.get(scholarId));
    expect(scholar?.readingLevelSuggestion).toBeUndefined();
  });

  test("the observer path refuses a model answer that is not a grade", async () => {
    const { t, scholarId } = await seed();
    const outcome = await t.mutation(internal.scholars.setReadingLevelSuggestion, {
      scholarId,
      suggestion: "advanced",
      typedWords: ENOUGH,
    });
    expect(outcome).toBe("invalid");
    const scholar = await t.run((ctx) => ctx.db.get(scholarId));
    expect(scholar?.readingLevelSuggestion).toBeUndefined();
  });

  test("a teacher setting the talk level records teacher + changedBy and keeps the estimate", async () => {
    const { t, school, scholarId, asTeacher } = await seed();
    await asTeacher.mutation(api.scholars.setReadingLevelSuggestionFromAnalysis, {
      scholarId,
      suggestion: "6.2",
      typedWords: ENOUGH,
    });

    await asTeacher.mutation(api.scholars.updateReadingLevel, {
      scholarId,
      readingLevel: "5",
    });

    const scholar = await t.run((ctx) => ctx.db.get(scholarId));
    expect(scholar?.readingLevel).toBe("5");
    expect(scholar?.readingLevelSuggestion).toBe("6.2");
    const rows = await t.run((ctx) => ctx.db.query("readingLevelHistory").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dimension: "talk",
      level: "5",
      source: "teacher",
      changedBy: school.teacher.id,
    });
  });
});

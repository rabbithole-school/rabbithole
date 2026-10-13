// TRA-513: what the observer hands the estimate writer. The observer action
// computes `typedScholarWordCount(window)` and passes it, with the model's
// grade, to `internal.scholars.setReadingLevelSuggestion`. This test runs that
// same composition on realistic transcripts: dictated speech must not earn an
// estimate; typed prose must, with its real word count.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { typedScholarWordCount, type ObserverHistoryMessage } from "../lib/observerShared";
import { countWords, MIN_TYPED_WORDS_FOR_ESTIMATE } from "../lib/readingLevels";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const turn = (
  content: string,
  inputModality?: "typed" | "spoken" | "app",
): ObserverHistoryMessage => ({
  role: "user",
  sourceRole: "user",
  content,
  ...(inputModality ? { inputModality } : {}),
});
const tutor = (content: string): ObserverHistoryMessage => ({
  role: "assistant",
  sourceRole: "assistant",
  content,
});

// Fluent, punctuated speech-to-text: what a dictating scholar's turns look like.
const SPOKEN_1 =
  "I think the volcano erupts because the pressure builds up underneath the crust, and when the magma finally finds a weak spot it forces its way out through the vent. That is also why some volcanoes are more explosive than others, since thicker magma traps more gas.";
const SPOKEN_2 =
  "Well, the lava from Hawaii is runnier than the lava from Mount St. Helens, so the gas can escape gently instead of building up, which would explain why the islands have shield volcanoes with gentle slopes.";

// Typed turns: short, lowercase, a few slips, like a real chat.
const TYPED_SHORT_1 = "idk maybe the lava is hot becuase of the center of the earth";
const TYPED_SHORT_2 = "ok so the gas makes it explode right";

const TYPED_HEAVY = [
  "i read that the ocean floor is made of big plates and they move really slowly, like about as fast as your fingernails grow",
  "when two plates push together one of them can slide under the other and that is called subduction, and it makes volcanoes along the edge",
  "my favorite one is the ring of fire because it goes all the way around the pacific ocean and has so many volcanoes and earthquakes",
  "i wonder if the plates will ever stop moving or if they will keep going for billions of years because the inside of the earth stays hot",
  "also i think the himalayas are still getting taller every year since india keeps pushing into asia, which is kind of amazing to think about",
];

async function seedScholar() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, {
    schools: 1,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  return { t, scholarId: world.schools[0].scholars[0].id };
}

describe("observer → estimate writer wiring", () => {
  test("a mostly-spoken session stores no estimate", async () => {
    const { t, scholarId } = await seedScholar();
    const history = [
      tutor("What do you think makes a volcano erupt?"),
      turn(SPOKEN_1, "spoken"),
      tutor("And why do some erupt more gently?"),
      turn(SPOKEN_2, "spoken"),
      turn(TYPED_SHORT_1, "typed"),
      turn(TYPED_SHORT_2),
      turn("Check my answer", "app"),
    ];
    const typedWords = typedScholarWordCount(history);
    // Only the typed turns count, however much was dictated.
    expect(typedWords).toBe(countWords(TYPED_SHORT_1) + countWords(TYPED_SHORT_2));
    expect(typedWords).toBeLessThan(MIN_TYPED_WORDS_FOR_ESTIMATE);

    const outcome = await t.mutation(internal.scholars.setReadingLevelSuggestion, {
      scholarId,
      suggestion: "9.5", // what a model reading the dictated prose would say
      typedWords,
    });
    expect(outcome).toBe("too_few_words");
    expect((await t.run((ctx) => ctx.db.get(scholarId)))?.readingLevelSuggestion).toBeUndefined();
  });

  test("a typed-heavy session passes its real typed word count through", async () => {
    const { t, scholarId } = await seedScholar();
    const history = [
      tutor("Tell me what you have been reading about."),
      ...TYPED_HEAVY.flatMap((text) => [turn(text, "typed"), tutor("Say more.")]),
      turn(SPOKEN_1, "spoken"),
    ];
    const typedWords = typedScholarWordCount(history);
    expect(typedWords).toBe(TYPED_HEAVY.reduce((n, text) => n + countWords(text), 0));
    expect(typedWords).toBeGreaterThanOrEqual(MIN_TYPED_WORDS_FOR_ESTIMATE);

    const outcome = await t.mutation(internal.scholars.setReadingLevelSuggestion, {
      scholarId,
      suggestion: "Grade 5.0",
      typedWords,
    });
    expect(outcome).toBe("stored");
    expect(await t.run((ctx) => ctx.db.get(scholarId))).toMatchObject({
      readingLevelSuggestion: "5",
      readingLevelSuggestionWords: typedWords,
    });
  });
});

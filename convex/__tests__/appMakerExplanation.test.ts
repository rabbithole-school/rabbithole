import { describe, expect, test } from "vitest";
import { buildCriteriaGenUserMessage } from "../deliverables";
import { APP_MAKER_EXPLANATION_CRITERION } from "../lib/appActivity";

/**
 * A Quest build step's app is graded by per-scholar auto criteria. One of
 * them is the maker's explanation of the app (Carl's metacognition ask),
 * riding the existing private rubric rather than a new surface. Only an app
 * deliverable asks for it.
 */
describe("criteria generator: the maker's explanation", () => {
  const bundle = {
    activityTitle: "Build a simulation of heron migration",
    activityDescription: null,
    deliverablePrompt: "Your simulation, running, showing what you figured out.",
    teacherNotes: null,
    readingLevel: "4",
    unitTitle: "Heron migration",
    lessonTitle: null,
    angleTitle: null,
    angleDescription: null,
    assessesWritingMechanics: false,
    isAppDeliverable: true,
  };

  test("an app deliverable asks for the maker's explanation criterion", () => {
    expect(buildCriteriaGenUserMessage(bundle)).toContain(
      APP_MAKER_EXPLANATION_CRITERION,
    );
  });

  test("any other deliverable does not", () => {
    expect(
      buildCriteriaGenUserMessage({ ...bundle, isAppDeliverable: false }),
    ).not.toContain(APP_MAKER_EXPLANATION_CRITERION);
  });
});
